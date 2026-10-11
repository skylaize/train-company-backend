import { prisma } from "../prisma";
import { botEnabled, BRAND_COLOR, Embed, esc, fmt, MessagePayload, postOnce, markPosted, upsertPost } from "./discord.service";
import { buildLeaderRows, rankRows } from "./leaderboard.service";
import { allianceRanking } from "./alliance.service";
import { currentSeason, DIVISIONS } from "./saison.service";
import { ensureProject, TUNNEL_NAME, TUNNEL_STATIONS } from "./world.service";

/* ============================================================
   Ce que le jeu publie tout seul sur Discord (2.1).

   - #classements : un seul message, modifié toutes les cinq minutes ;
   - #patch-notes : les nouveautés de chaque version, lues dans le
     changelog.json publié par le site à chaque build ;
   - #saisons : ouverture et clôture des saisons, avec les champions ;
   - #grand-chantier : 25, 50, 75 % et l'ouverture du tunnel.

   Chaque annonce a une clé (table DiscordPost) : rien n'est publié deux
   fois, même après un redémarrage.
   ============================================================ */

const SITE_URL = (process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
const MEDALS = ["🥇", "🥈", "🥉"];
const medal = (i: number) => MEDALS[i] ?? `\`${String(i + 1).padStart(2, " ")}\``;
const parisDay = (d: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long" }).format(d);

/* ---------------- classement en direct ---------------- */

export async function updateLeaderboardPost() {
  const [rows, alliances, season] = await Promise.all([buildLeaderRows(), allianceRanking(), currentSeason()]);
  const top = rankRows(rows, "valeur").slice(0, 10);
  const fields: Embed["fields"] = [
    {
      name: "🚂 Valeur des compagnies",
      value: top.length ? top.map((r, i) => `${medal(i)} **${esc(r.name)}** — ${fmt(r.valeur)} pi.`).join("\n") : "Personne pour l'instant.",
    },
  ];

  if (season) {
    const entries = (await prisma.seasonEntry.findMany({
      where: { seasonId: season.id, points: { gt: 0 } },
      orderBy: { points: "desc" },
      take: 10,
      select: { companyId: true, points: true, division: true },
    })) as { companyId: string; points: number; division: number }[];
    const names = new Map(rows.map((r) => [r.id, r.name]));
    const daysLeft = Math.max(0, Math.ceil((season.endsAt.getTime() - Date.now()) / 86_400_000));
    fields.push({
      name: `🏆 ${season.name} — encore ${daysLeft} j`,
      value: entries.length
        ? entries.map((e, i) => `${medal(i)} **${esc(names.get(e.companyId) ?? "—")}** — ${fmt(e.points)} pts · ${DIVISIONS[e.division]}`).join("\n")
        : "Aucun point marqué pour l'instant.",
    });
  }

  if (alliances.length) {
    fields.push({
      name: "🤝 Alliances",
      value: alliances.slice(0, 5).map((a, i) => `${medal(i)} **${esc(a.name)}** — ${fmt(a.points)} pts · ${a.members} membre${a.members > 1 ? "s" : ""}`).join("\n"),
    });
  }

  await upsertPost("classement", "CLASSEMENTS", {
    embeds: [
      {
        title: "Classement du réseau",
        url: SITE_URL ? `${SITE_URL}/dashboard` : undefined,
        color: BRAND_COLOR,
        fields,
        footer: { text: "Mis à jour toutes les 5 minutes · /classement pour les autres tableaux" },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

/* ---------------- notes de version ---------------- */

type Changelog = { version: string; date: string; changes: { type: "nouveau" | "ameliore" | "corrige"; text: string }[] };
const SECTIONS: [Changelog["changes"][number]["type"], string][] = [
  ["nouveau", "✨ Nouveau"],
  ["ameliore", "🔧 Amélioré"],
  ["corrige", "🐛 Corrigé"],
];

/* Découpe les notes en messages : une description d'embed tient 4 096
   caractères, on garde de la marge. */
export function patchNotePayloads(c: Changelog): MessagePayload[] {
  const lines: string[] = [];
  for (const [type, label] of SECTIONS) {
    const items = c.changes.filter((x) => x.type === type);
    if (!items.length) continue;
    if (lines.length) lines.push("");
    lines.push(`**${label}**`);
    for (const it of items) lines.push(`• ${it.text}`);
  }
  const chunks: string[] = [];
  let cur = "";
  for (const line of lines) {
    const piece = line.length > 3800 ? `${line.slice(0, 3797)}…` : line;
    if (cur && cur.length + piece.length + 1 > 3800) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${piece}` : piece;
  }
  if (cur) chunks.push(cur);
  return chunks.map((description, i) => ({
    embeds: [
      {
        title: i === 0 ? `Réseau ${c.version}` : `Réseau ${c.version} (suite ${i + 1}/${chunks.length})`,
        url: i === 0 && SITE_URL ? SITE_URL : undefined,
        description,
        color: BRAND_COLOR,
        footer: i === chunks.length - 1 ? { text: c.date } : undefined,
      },
    ],
  }));
}

let lastChangelogCheck = 0;
async function checkPatchNotes() {
  if (!SITE_URL || Date.now() - lastChangelogCheck < 10 * 60_000) return;
  lastChangelogCheck = Date.now();
  const r = await fetch(`${SITE_URL}/changelog.json`, { headers: { "Cache-Control": "no-cache" } });
  if (!r.ok) return;
  const c = (await r.json().catch(() => null)) as Changelog | null;
  if (!c?.version || !Array.isArray(c.changes)) return;
  await postOnce(`patch:${c.version}`, "PATCH_NOTES", patchNotePayloads(c), { crosspost: true, ping: "MAJ" });
}

/* ---------------- saisons ---------------- */

async function checkSeasonStart() {
  const season = await currentSeason();
  if (!season) return;
  await postOnce(`saison-debut:${season.number}`, "SAISONS", [
    {
      embeds: [
        {
          title: `${season.name} — c'est parti !`,
          url: SITE_URL ? `${SITE_URL}/dashboard` : undefined,
          description: [
            `La saison ${season.number} est ouverte jusqu'au **${parisDay(season.endsAt)}**.`,
            "",
            "Le classement repart à zéro, votre compagnie garde tout. Trajets bien remplis, fret livré et objectifs de la semaine font les points.",
            "Les 3 premiers de chaque groupe montent de division, la première moitié gagne la livrée et le titre de la saison.",
          ].join("\n"),
          color: BRAND_COLOR,
        },
      ],
    },
  ], { crosspost: true, ping: "EVENEMENTS" });
}

/* Appelé par la simulation au moment où une saison se clôt. */
export async function announceSeasonEnd(seasonId: string) {
  if (!botEnabled()) return;
  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) return;
  const champions = (await prisma.seasonEntry.findMany({
    where: { seasonId, finalRank: 1, points: { gt: 0 } },
    orderBy: [{ division: "desc" }, { groupNo: "asc" }],
    select: { companyId: true, division: true, groupNo: true, points: true },
  })) as { companyId: string; division: number; groupNo: number; points: number }[];
  const names = new Map(
    ((await prisma.company.findMany({ where: { id: { in: champions.map((c) => c.companyId) } }, select: { id: true, name: true } })) as { id: string; name: string }[]).map((c) => [c.id, c.name])
  );
  const fields = DIVISIONS.map((div, d) => {
    const list = champions.filter((c) => c.division === d);
    return list.length
      ? { name: `${["🥉", "🥈", "🥇", "💠"][d]} ${div}`, value: list.slice(0, 15).map((c) => `Groupe ${c.groupNo} : **${esc(names.get(c.companyId) ?? "—")}** (${fmt(c.points)} pts)`).join("\n") }
      : null;
  })
    .filter(Boolean)
    .reverse() as Embed["fields"];
  await postOnce(`saison-fin:${season.number}`, "SAISONS", [
    {
      embeds: [
        {
          title: `${season.name} terminée`,
          description: "Bravo aux champions de chaque groupe ! Les montées et descentes sont appliquées, la saison suivante démarre tout de suite.",
          color: BRAND_COLOR,
          fields: fields?.length ? fields : undefined,
        },
      ],
    },
  ], { crosspost: true, ping: "EVENEMENTS" });
}

/* ---------------- Grand Chantier ---------------- */

const MILESTONES = [25, 50, 75, 100];
async function checkWorld() {
  const p = await ensureProject();
  const pct = p.completedAt ? 100 : Math.floor((Math.min(p.progress, p.target) / p.target) * 100);
  const reached = MILESTONES.filter((m) => pct >= m);
  if (!reached.length) return;
  const top = reached[reached.length - 1];
  const description =
    top === 100
      ? `**${TUNNEL_NAME} est ouvert !** ${TUNNEL_STATIONS.join(" et ")} rejoignent la carte pour tout le monde. Merci à chaque compagnie qui a creusé.`
      : `${TUNNEL_NAME} est creusé à **${top} %** (${fmt(p.progress)} / ${fmt(p.target)} trajets). Chaque trajet voyageurs fait avancer le chantier.`;
  const posted = await postOnce(`chantier:${top}`, "CHANTIER", [
    { embeds: [{ title: top === 100 ? "🎉 Le tunnel est ouvert" : `⛏️ Grand Chantier : ${top} %`, description, color: BRAND_COLOR }] },
  ], { ping: "EVENEMENTS" });
  // les paliers déjà dépassés (premier démarrage en cours de route) ne sont pas rattrapés
  if (posted) for (const m of reached.slice(0, -1)) await markPosted(`chantier:${m}`);
}

/* ---------------- un passage, toutes les cinq minutes ---------------- */

export async function runDiscordFeed() {
  if (!botEnabled()) return;
  const steps: [string, () => Promise<unknown>][] = [
    ["classement", updateLeaderboardPost],
    ["notes de version", checkPatchNotes],
    ["saison", checkSeasonStart],
    ["chantier", checkWorld],
  ];
  for (const [label, fn] of steps) {
    await fn().catch((err) => console.error(`[discord] ${label} :`, (err as Error).message));
  }
}
