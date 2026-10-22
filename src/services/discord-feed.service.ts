import { prisma } from "../prisma";
import { botEnabled, BRAND_COLOR, Embed, esc, fmt, MessagePayload, postOnce, markPosted, upsertPost } from "./discord.service";
import { buildLeaderRows, rankRows } from "./leaderboard.service";
import { allianceRanking } from "./alliance.service";
import { currentSeason, DIVISIONS } from "./saison.service";
import { ensureProject, TUNNEL_NAME, TUNNEL_STATIONS } from "./world.service";
import { pruneLogKeys } from "./discord-modlog.service";
import { Stop, TRAIN200_ID, TRAIN200_REWARD } from "./train200.service";
import { currentEdition, HAUNT_MINUTES, HAUNT_DEMAND, TIERS, topHunters, hauntSchedule, NIGHT_SOULS_FROM, NIGHT_SOULS_TO } from "./halloween.service";

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

/* Un message tenu à jour dans #grand-chantier : l'avancée du tunnel et
   les cinq compagnies qui ont le plus creusé. */
const bar = (pct: number) => "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
async function updateWorldPost() {
  const p = await ensureProject();
  const pct = p.completedAt ? 100 : Math.min(100, (Math.min(p.progress, p.target) / p.target) * 100);
  const top = (await prisma.worldContribution.findMany({ where: { projectId: p.id }, orderBy: { amount: "desc" }, take: 5 })) as { companyId: string; amount: number }[];
  const names = new Map(
    ((await prisma.company.findMany({ where: { id: { in: top.map((t) => t.companyId) } }, select: { id: true, name: true } })) as { id: string; name: string }[]).map((c) => [c.id, c.name])
  );
  const contributors = await prisma.worldContribution.count({ where: { projectId: p.id } });
  await upsertPost("chantier-live", "CHANTIER", {
    embeds: [
      {
        title: p.completedAt ? `🎉 ${TUNNEL_NAME} est ouvert` : `⛏️ ${TUNNEL_NAME}`,
        url: SITE_URL ? `${SITE_URL}/dashboard` : undefined,
        description: [
          `\`${bar(pct)}\` **${pct.toFixed(1).replace(".", ",")} %**`,
          `${fmt(Math.min(p.progress, p.target))} / ${fmt(p.target)} trajets · ${fmt(contributors)} compagnie${contributors > 1 ? "s" : ""} au chantier`,
          "",
          p.completedAt
            ? `${TUNNEL_STATIONS.join(" et ")} sont sur la carte pour tout le monde.`
            : `Chaque trajet voyageurs de chaque joueur creuse le tunnel. À l'ouverture, ${TUNNEL_STATIONS.join(" et ")} rejoignent la carte.`,
        ].join("\n"),
        color: BRAND_COLOR,
        fields: top.length
          ? [{ name: "Les plus gros bâtisseurs", value: top.map((t, i) => `${medal(i)} **${esc(names.get(t.companyId) ?? "—")}** — ${fmt(t.amount)} trajets`).join("\n") }]
          : undefined,
        footer: { text: "Mis à jour toutes les 5 minutes" },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

/* ---------------- 2.1.2 : la fête des 200 ---------------- */

const parisTime = (d: Date) =>
  new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d).replace(":", " h ");
const parisHour = (d: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(d).replace(":", " h ");

/* Trois messages dans #annonces, chacun une seule fois :
   - à la mise en ligne de la 2.1.2 : l'événement, avec l'heure de départ ;
   - au départ du train : l'horaire complet, gare par gare ;
   - au terminus : les compagnies peintes sur ses voitures. */
async function checkTrain200() {
  const [train, taken] = await Promise.all([
    prisma.specialTrain.findUnique({ where: { id: TRAIN200_ID } }),
    prisma.company.count({ where: { pioneerNumber: { not: null } } }),
  ]);
  const envStart = process.env.TRAIN200_START ? new Date(process.env.TRAIN200_START) : null;
  const start = train?.startsAt ?? (envStart && !Number.isNaN(envStart.getTime()) ? envStart : null);
  const site = SITE_URL || undefined;

  await postOnce("fete-200:annonce", "ANNONCES", [
    {
      embeds: [
        {
          title: "🎉 200 compagnies sur le réseau !",
          url: site,
          description: [
            "Vous êtes plus de 200 à faire rouler des trains sur Réseau. **Merci.** Pour fêter ça, la **2.1.2** arrive avec trois cadeaux :",
            "",
            `🚆 **Le Train des 200** — un train spécial fait le tour de France en **48 heures**, par toutes les gares du réseau. Suivez-le en direct sur la carte. Quand il passe par une de vos gares, vous touchez **${TRAIN200_REWARD} pi.** et le nom de votre compagnie est peint sur ses voitures.`,
            start ? `Départ de Paris **${parisTime(start)}**.` : "Il part dans quelques minutes : ouvrez la carte !",
            "",
            `🎟️ **Les billets de pionnier** — les ${taken > 0 ? taken : 200} premières compagnies reçoivent un billet numéroté dans l'ordre de leur fondation. Ce numéro ne changera jamais.`,
            "",
            "🗺️ **La grande carte des 200** — tous les réseaux superposés sur une seule carte de France, chacun à sa livrée, avec tous les noms. À télécharger, imprimer et partager.",
            "",
            "Tout est dans la flotte, ou dans Paramètres. Partagez votre billet ici, on veut les voir !",
          ].join("\n"),
          color: 0xd4a017,
          image: site ? { url: `${site}/og-image.png?v=5` } : undefined,
          footer: { text: "Réseau 2.1.2 · octobre 2026" },
        },
      ],
    },
  ], { crosspost: true, ping: "EVENEMENTS" });

  if (!train) return;
  const route = train.route as unknown as Stop[];
  const now = Date.now();

  if (now >= train.startsAt.getTime()) {
    // l'horaire, par blocs de 14 gares (un champ d'embed tient 1 024 caractères)
    const lines = route.map((s) => `\`${parisHour(new Date(s.at))}\` ${esc(s.station)}`);
    const fields: Embed["fields"] = [];
    for (let i = 0; i < lines.length && fields.length < 6; i += 14) {
      fields.push({ name: i === 0 ? "L'horaire" : "\u200b", value: lines.slice(i, i + 14).join("\n"), inline: true });
    }
    await postOnce("fete-200:depart", "ANNONCES", [
      {
        embeds: [
          {
            title: "🚆 Le Train des 200 est parti !",
            url: site ? `${site}/dashboard` : undefined,
            description: [
              `Il a quitté ${esc(route[0].station)} pour **${route.length} gares** en 48 heures. Arrivée à ${esc(route[route.length - 1].station)} ${parisTime(train.endsAt)}.`,
              `Chaque compagnie qui dessert une gare de son trajet touche **${TRAIN200_REWARD} pi.** à son passage, et son nom rejoint ses voitures.`,
              "Pas de gare sur son trajet ? Il est encore temps d'ouvrir une ligne.",
            ].join("\n"),
            color: 0xd4a017,
            fields,
          },
        ],
      },
    ], { crosspost: true, ping: "EVENEMENTS" });
  }

  if (now >= train.endsAt.getTime() && train.lastStop >= route.length - 1) {
    const visits = (await prisma.specialTrainVisit.findMany({ where: { trainId: TRAIN200_ID }, orderBy: { at: "asc" }, select: { companyId: true } })) as { companyId: string }[];
    const names = (await prisma.company.findMany({ where: { id: { in: visits.map((v) => v.companyId) } }, select: { id: true, name: true } })) as { id: string; name: string }[];
    const byId = new Map(names.map((c) => [c.id, c.name]));
    let list = "";
    let shown = 0;
    for (const v of visits) {
      const n = byId.get(v.companyId);
      if (!n) continue;
      const piece = `${list ? " · " : ""}${esc(n)}`;
      if (list.length + piece.length > 3200) break;
      list += piece;
      shown++;
    }
    await postOnce("fete-200:arrivee", "ANNONCES", [
      {
        embeds: [
          {
            title: "🏁 Terminus pour le Train des 200",
            url: site ? `${site}/dashboard` : undefined,
            description: [
              `Après 48 heures et ${route.length} gares, il est arrivé à ${esc(route[route.length - 1].station)} avec **${visits.length} compagnies** peintes sur ses voitures. Merci à toutes !`,
              "",
              list + (visits.length > shown ? ` · et ${visits.length - shown} autres` : ""),
            ].join("\n"),
            color: 0xd4a017,
          },
        ],
      },
    ], { crosspost: true });
  }
}

/* ---------------- 2.2 : Halloween ---------------- */

const HALLOWEEN_COLOR = 0x6b4c9a;

async function checkHalloween() {
  const ed = currentEdition();
  const now = Date.now();
  const site = SITE_URL || undefined;
  if (now >= ed.start.getTime() && now < ed.end.getTime()) {
    const route = await hauntSchedule();
    const first = route.filter((h) => new Date(h.at).getTime() >= now - HAUNT_MINUTES * 60_000).slice(0, 4);
    await postOnce(`halloween:${ed.year}:debut`, "ANNONCES", [
      {
        embeds: [
          {
            title: "🎃 Le Train fantôme hante le réseau",
            url: site ? `${site}/dashboard` : undefined,
            description: [
              `Jusqu'au ${parisDay(new Date(ed.end.getTime() - 1))}, il s'installe toutes les ${HAUNT_MINUTES} minutes dans une gare du réseau. Les curieux s'y pressent (voyageurs ×${String(HAUNT_DEMAND).replace(".", ",")}).`,
              `Chaque trajet qui passe par la gare hantée récolte **une âme**, deux de ${NIGHT_SOULS_FROM} h à ${NIGHT_SOULS_TO} h. L'horaire est dans le jeu : envoyez vos rames là où il va.`,
              "",
              TIERS.map((t) => `**${t.souls} âmes** · ${t.label.toLowerCase()}`).join("\n"),
              "",
              "Gardés pour toujours. Et un classement des chasseurs toute la semaine.",
            ].join("\n"),
            color: HALLOWEEN_COLOR,
            fields: first.length
              ? [{ name: "Ses prochaines gares", value: first.map((h) => `\`${new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(new Date(h.at))}\` ${esc(h.station)}`).join("\n") }]
              : undefined,
          },
        ],
      },
    ], { crosspost: true, ping: "EVENEMENTS" });
  }
  // la fin, avec les meilleurs chasseurs, dans les trois jours qui suivent
  if (now >= ed.end.getTime() && now < ed.end.getTime() + 3 * 86_400_000) {
    const top = await topHunters(ed.year, 5);
    const hunters = await prisma.halloweenSoul.count({ where: { year: ed.year, souls: { gt: 0 } } });
    await postOnce(`halloween:${ed.year}:fin`, "ANNONCES", [
      {
        embeds: [
          {
            title: "🕯️ Le Train fantôme est reparti",
            url: site ? `${site}/dashboard` : undefined,
            description: [
              `${hunters} compagnie${hunters > 1 ? "s ont" : " a"} récolté des âmes cette semaine. Les meilleurs chasseurs :`,
              "",
              top.length ? top.map((t, i) => `${medal(i)} ${esc(t.name)} · **${fmt(t.souls)}** âmes`).join("\n") : "Personne cette fois.",
              "",
              "Ce que vous avez débloqué est gardé pour toujours. Rendez-vous l'an prochain.",
            ].join("\n"),
            color: HALLOWEEN_COLOR,
          },
        ],
      },
    ], { crosspost: true });
  }
}

/* ---------------- un passage, toutes les cinq minutes ---------------- */

export async function runDiscordFeed() {
  if (!botEnabled()) return;
  const steps: [string, () => Promise<unknown>][] = [
    ["classement", updateLeaderboardPost],
    ["notes de version", checkPatchNotes],
    ["saison", checkSeasonStart],
    ["chantier", updateWorldPost],
    ["chantier, paliers", checkWorld],
    ["fête des 200", checkTrain200],
    ["halloween", checkHalloween],
    ["ménage du journal", pruneLogKeys],
  ];
  for (const [label, fn] of steps) {
    await fn().catch((err) => console.error(`[discord] ${label} :`, (err as Error).message));
  }
}
