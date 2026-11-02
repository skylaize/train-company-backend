import { prisma } from "../prisma";
import { BRAND_COLOR, Embed, esc, fmt } from "../services/discord.service";
import { STATIONS } from "../services/geography.service";
import { SIZE_LABEL, stationSize, activeStationEvents, upcomingStationEvents } from "../services/station.service";
import { weatherMap, WEATHER_EFFECTS } from "../services/realweather.service";
import { REGIONS, REGION_OF } from "../services/regions.service";
import { worldView, TUNNEL_STATIONS } from "../services/world.service";
import { currentSeason, seasonView, DIVISIONS } from "../services/saison.service";
import { buildLeaderRows, rankRows } from "../services/leaderboard.service";
import { DM_ALL, DM_CATEGORIES, DmCategory, parseDmSetting } from "../services/discord-dm.service";

/* ============================================================
   Commandes Discord de la 2.5 : /gare, /chantier, /saison, /comparer et
   /notifs. Chacune renvoie le corps d'un message ({ content?, embeds? }).
   ============================================================ */

type Reply = { content?: string; embeds?: Embed[] };
const SITE_URL = (process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
const DAY = 86_400_000;
const ts = (d: Date, style = "R") => `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;
const bar = (pct: number) => "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const medal = (i: number) => ["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`;

export const DM_CHOICES = [{ name: "Tout", value: "tout" }, ...DM_ALL.map((c) => ({ name: `${DM_CATEGORIES[c].emoji} ${DM_CATEGORIES[c].label}`, value: c }))];

export const NEW_COMMANDS = [
  {
    name: "gare",
    description: "Une gare : qui la dessert, la météo réelle, les événements, la région",
    options: [{ type: 3, name: "nom", description: "Le nom de la gare", required: true, autocomplete: true }],
  },
  { name: "chantier", description: "Où en est le tunnel du Mont-Blanc, et qui creuse le plus" },
  { name: "saison", description: "La saison en cours : votre groupe, vos points, vos objectifs de la semaine" },
  {
    name: "comparer",
    description: "Comparer deux compagnies",
    options: [
      { type: 6, name: "joueur", description: "Le joueur à comparer", required: true },
      { type: 6, name: "avec", description: "Avec qui (vous par défaut)", required: false },
    ],
  },
  {
    name: "notifs",
    description: "Recevoir les notifications du jeu en message privé",
    options: [
      { type: 3, name: "categorie", description: "Quelles notifications (laisser vide pour voir vos réglages)", required: false, choices: DM_CHOICES },
      { type: 3, name: "etat", description: "Activer ou désactiver", required: false, choices: [{ name: "Activer", value: "on" }, { name: "Désactiver", value: "off" }] },
    ],
  },
];

/* ---------------- autocomplétion des gares ---------------- */

export function stationChoices(typed: string) {
  const q = norm(typed);
  const list = STATIONS.filter((s) => !q || norm(s).includes(q)).sort((a, b) => {
    const pa = norm(a).startsWith(q) ? 0 : 1;
    const pb = norm(b).startsWith(q) ? 0 : 1;
    return pa - pb || stationSize(b) - stationSize(a) || a.localeCompare(b, "fr");
  });
  return list.slice(0, 25).map((s) => ({ name: s, value: s }));
}

async function companyOf(discordId: string) {
  const u = await prisma.user.findUnique({ where: { discordId }, select: { company: { select: { id: true, name: true } } } });
  return u?.company ?? null;
}

/* ---------------- /gare ---------------- */

export async function gareReply(raw: string | undefined, callerId: string): Promise<Reply> {
  const q = norm(raw ?? "");
  const station = STATIONS.find((s) => norm(s) === q) ?? STATIONS.find((s) => norm(s).startsWith(q));
  if (!q || !station) return { content: `Je ne connais pas la gare « ${esc(raw ?? "")} ». Commence à taper son nom, la liste se complète toute seule.` };

  const [lines, owner, wx, active, upcoming, me] = await Promise.all([
    prisma.line.findMany({
      where: { OR: [{ departureStation: station }, { arrivalStation: station }, { stops: { has: station } }] },
      select: { companyId: true, _count: { select: { trains: true } } },
    }) as Promise<{ companyId: string; _count: { trains: number } }[]>,
    prisma.stationOwnership.findUnique({ where: { station }, select: { level: true, company: { select: { name: true } } } }),
    weatherMap(),
    activeStationEvents(),
    upcomingStationEvents(),
    companyOf(callerId),
  ]);

  // compagnies qui la desservent, par nombre de rames
  const trainsBy = new Map<string, number>();
  for (const l of lines) trainsBy.set(l.companyId, (trainsBy.get(l.companyId) ?? 0) + l._count.trains);
  const ranked = [...trainsBy.entries()].sort((a, b) => b[1] - a[1]);
  const names = new Map(
    ((await prisma.company.findMany({ where: { id: { in: ranked.slice(0, 5).map(([id]) => id) } }, select: { id: true, name: true } })) as { id: string; name: string }[]).map((c) => [c.id, c.name])
  );
  const totalTrains = ranked.reduce((s, [, n]) => s + n, 0);

  const fields: NonNullable<Embed["fields"]> = [];
  fields.push({
    name: "🚉 Desserte",
    value: ranked.length
      ? `${ranked.length} compagnie${ranked.length > 1 ? "s" : ""} · ${fmt(totalTrains)} rame${totalTrains > 1 ? "s" : ""}\n` +
        ranked.slice(0, 5).map(([id, n], i) => `${medal(i)} ${esc(names.get(id) ?? "—")} — ${n} rame${n > 1 ? "s" : ""}`).join("\n") +
        (me ? `\n${trainsBy.has(me.id) ? `✅ Vous la desservez (${trainsBy.get(me.id)} rame${(trainsBy.get(me.id) ?? 0) > 1 ? "s" : ""})` : "Vous ne la desservez pas encore"}` : "")
      : "Aucune ligne ne s'y arrête pour l'instant. La place est libre !",
  });

  const w = wx.get(station);
  if (w) {
    const e = WEATHER_EFFECTS[w.kind];
    fields.push({ name: "🌦️ Météo réelle", value: `${e.label}, ${Math.round(w.temp)} °C${e.effect ? `\n*${e.effect}*` : ""}`, inline: true });
  }

  const ev = active.find((x) => x.station === station);
  const next = upcoming.find((x) => x.station === station);
  if (ev || next) {
    const pct = (m: number) => `${m >= 1 ? "+" : ""}${Math.round((m - 1) * 100)} % de voyageurs`;
    fields.push({
      name: "🎪 Événement",
      value: ev ? `**${ev.label}** en cours (${pct(ev.multiplier)}), fin ${ts(ev.endsAt)}` : `**${next!.label}** ${ts(next!.startsAt)} (${pct(next!.multiplier)})`,
      inline: true,
    });
  }

  const regionId = REGION_OF[station];
  const region = REGIONS.find((r) => r.id === regionId);
  if (region) {
    const ctrl = await prisma.regionControl.findFirst({ where: { region: region.id }, orderBy: { weekStart: "desc" }, select: { allianceId: true } });
    const holder = ctrl?.allianceId ? await prisma.alliance.findUnique({ where: { id: ctrl.allianceId }, select: { name: true } }) : null;
    fields.push({ name: "🗺️ Région", value: `${region.name}\n${holder ? `Tenue par **${esc(holder.name)}**` : "Tenue par personne"}`, inline: true });
  }

  fields.push({ name: "🏛️ Propriétaire", value: owner ? `${esc(owner.company.name)} · niveau ${owner.level}` : "Personne : elle est à vendre", inline: true });

  return {
    embeds: [
      {
        title: `🚉 ${station}`,
        description: `${SIZE_LABEL[stationSize(station)] ?? "Ville"}${TUNNEL_STATIONS.includes(station) ? " · au bout du tunnel du Mont-Blanc" : ""}`,
        url: SITE_URL ? `${SITE_URL}/dashboard` : undefined,
        color: BRAND_COLOR,
        fields,
      },
    ],
  };
}

/* ---------------- /chantier ---------------- */

export async function chantierReply(callerId: string): Promise<Reply> {
  const me = await companyOf(callerId);
  const w = await worldView(me?.id ?? "");
  const pct = w.completedAt ? 100 : Math.min(100, (w.progress / w.target) * 100);
  return {
    embeds: [
      {
        title: w.completedAt ? `🎉 ${w.name} est ouvert` : `⛏️ ${w.name}`,
        description: [
          `\`${bar(pct)}\` **${pct.toFixed(1).replace(".", ",")} %**`,
          `${fmt(w.progress)} / ${fmt(w.target)} trajets · ${fmt(w.contributors)} compagnie${w.contributors > 1 ? "s" : ""} au chantier`,
          w.completedAt ? `${w.stations.join(" et ")} sont sur la carte pour tout le monde.` : `À l'ouverture, ${w.stations.join(" et ")} rejoignent la carte.`,
        ].join("\n"),
        color: BRAND_COLOR,
        fields: [
          ...(w.top.length ? [{ name: "Les plus gros bâtisseurs", value: w.top.map((t) => `${medal(t.rank - 1)} ${esc(t.name)} — ${fmt(t.amount)} trajets`).join("\n") }] : []),
          ...(me ? [{ name: "Votre part", value: `${fmt(w.mine)} trajets${w.mine >= w.builderMin ? " · emblème « Bâtisseur du tunnel » gagné ✅" : ` · emblème « Bâtisseur » à ${fmt(w.builderMin)}`}` }] : []),
        ],
      },
    ],
  };
}

/* ---------------- /saison ---------------- */

export async function saisonReply(callerId: string): Promise<Reply> {
  const season = await currentSeason();
  if (!season) return { content: "Aucune saison en cours." };
  const me = await companyOf(callerId);
  if (!me) {
    const top = (await prisma.seasonEntry.findMany({ where: { seasonId: season.id, points: { gt: 0 } }, orderBy: { points: "desc" }, take: 5, select: { companyId: true, points: true, division: true } })) as {
      companyId: string; points: number; division: number;
    }[];
    const names = new Map(((await prisma.company.findMany({ where: { id: { in: top.map((t) => t.companyId) } }, select: { id: true, name: true } })) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
    return {
      embeds: [{
        title: `🏆 ${season.name}`,
        description: `Fin ${ts(season.endsAt)}\n\n${top.map((t, i) => `${medal(i)} **${esc(names.get(t.companyId) ?? "—")}** — ${fmt(t.points)} pts · ${DIVISIONS[t.division]}`).join("\n") || "Aucun point marqué pour l'instant."}\n\nLiez votre compte avec **/lier** pour voir votre groupe et vos objectifs.`,
        color: BRAND_COLOR,
      }],
    };
  }
  const v = await seasonView(me.id);
  if (!v.season || !("me" in v) || !v.me) return { content: "Votre compagnie n'est pas encore entrée dans la saison : elle y entre à son premier point." };
  const group = (v.group ?? []).slice(0, 12);
  const left = Math.max(0, Math.ceil((new Date(v.season.endsAt).getTime() - Date.now()) / DAY));
  return {
    embeds: [{
      title: `🏆 ${v.season.name} · semaine ${v.season.week}/${v.season.weeks}`,
      description: `**${v.me.rank}e** sur ${v.me.groupSize} dans le groupe ${v.me.groupNo} · ${v.me.divisionName} · **${fmt(v.me.points)} pts**\nFin de saison dans ${left} jour${left > 1 ? "s" : ""}${v.movers ? ` · les ${v.movers} premiers montent, les ${v.movers} derniers descendent` : ""}`,
      color: BRAND_COLOR,
      fields: [
        {
          name: "Objectifs de la semaine",
          value: (v.objectives ?? []).map((o) => `${o.done ? "✅" : "▫️"} ${o.label} — ${o.progress}/${o.target} · +${o.points} pts`).join("\n") || "—",
        },
        {
          name: `Votre groupe`,
          value: group.map((g) => `${g.isMe ? "**" : ""}${g.rank}. ${esc(g.name)} — ${fmt(g.points)} pts${g.trend > 0 ? " ▲" : g.trend < 0 ? " ▼" : ""}${g.isMe ? "**" : ""}`).join("\n"),
        },
      ],
      footer: { text: `Récompense : le titre « ${v.reward.title} » et la livrée ${v.reward.liveryName}, pour les ${v.reward.cut} premiers du groupe` },
    }],
  };
}

/* ---------------- /comparer ---------------- */

export async function comparerReply(aDiscord: string, bDiscord: string): Promise<Reply> {
  if (aDiscord === bDiscord) return { content: "Choisis un autre joueur que toi-même 😉" };
  const [a, b] = await Promise.all([companyOf(aDiscord), companyOf(bDiscord)]);
  if (!a || !b) return { content: `${!a ? `<@${aDiscord}>` : `<@${bDiscord}>`} n'a pas lié son compte Réseau à Discord.` };
  const rows = await buildLeaderRows();
  const byValue = rankRows(rows, "valeur");
  const ra = byValue.find((r) => r.id === a.id);
  const rb = byValue.find((r) => r.id === b.id);
  if (!ra || !rb) return { content: "Une des deux compagnies n'apparaît pas encore au classement." };
  const season = await currentSeason();
  const entries = season
    ? new Map(((await prisma.seasonEntry.findMany({ where: { seasonId: season.id, companyId: { in: [a.id, b.id] } }, select: { companyId: true, points: true, division: true } })) as { companyId: string; points: number; division: number }[]).map((e) => [e.companyId, e]))
    : new Map();
  const col = (r: typeof ra, wins: (k: "valeur" | "trains" | "lines" | "livraisons" | "ponctualite") => boolean) => {
    const e = entries.get(r.id);
    const star = (k: "valeur" | "trains" | "lines" | "livraisons" | "ponctualite") => (wins(k) ? " ⭐" : "");
    return [
      `**${r.grade}**`,
      `💰 ${fmt(r.valeur)} pi. (#${r.rank})${star("valeur")}`,
      `🚂 ${r.trains} rames${star("trains")}`,
      `🗺️ ${r.lines} lignes${star("lines")}`,
      `📦 ${r.livraisons} fret cette semaine${star("livraisons")}`,
      `⏱️ ${r.ponctualiteSample >= 10 ? `${Math.round(r.ponctualite)} % à l'heure` : "ponctualité : trop peu de trajets"}${r.ponctualiteSample >= 10 ? star("ponctualite") : ""}`,
      ...(e ? [`🏆 ${fmt(e.points)} pts · ${DIVISIONS[e.division]}`] : []),
    ].join("\n");
  };
  return {
    embeds: [{
      title: `⚖️ ${a.name} contre ${b.name}`,
      color: BRAND_COLOR,
      fields: [
        { name: esc(a.name), value: col(ra, (k) => ra[k] > rb[k]), inline: true },
        { name: esc(b.name), value: col(rb, (k) => rb[k] > ra[k]), inline: true },
      ],
      footer: { text: "⭐ = devant sur ce point" },
    }],
  };
}

/* ---------------- /notifs ---------------- */

export async function notifsReply(callerId: string, categorie: string | undefined, etat: string | undefined): Promise<Reply> {
  const user = await prisma.user.findUnique({ where: { discordId: callerId }, select: { id: true, discordDm: true } });
  if (!user) return { content: "Pour recevoir les notifications du jeu en message privé, lie d'abord ton compte : dans le jeu, **Paramètres → Lier mon Discord**." };
  const current = parseDmSetting(user.discordDm);

  if (categorie) {
    const targets: DmCategory[] = categorie === "tout" ? DM_ALL : DM_ALL.includes(categorie as DmCategory) ? [categorie as DmCategory] : [];
    const on = etat !== "off";
    for (const t of targets) on ? current.add(t) : current.delete(t);
    await prisma.user.update({ where: { id: user.id }, data: { discordDm: [...current].join(",") } });
  }

  const lines = DM_ALL.map((c) => `${current.has(c) ? "✅" : "▫️"} ${DM_CATEGORIES[c].emoji} **${DM_CATEGORIES[c].label}** — ${DM_CATEGORIES[c].detail}`);
  return {
    embeds: [{
      title: categorie ? "Réglages enregistrés" : "Vos notifications en message privé",
      description: `${lines.join("\n")}\n\n${current.size ? "Tu reçois ces catégories en message privé, en plus du navigateur." : "Aucune pour l'instant."}\nExemple : \`/notifs categorie:Fret etat:Activer\`\n\nPense à autoriser les messages privés du serveur Réseau (clic droit sur le serveur → Paramètres de confidentialité).`,
      color: BRAND_COLOR,
    }],
  };
}
