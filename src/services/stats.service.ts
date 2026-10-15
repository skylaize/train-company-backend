import { prisma } from "../prisma";
import { botEnabled, BRAND_COLOR, Embed, fmt, GUILD_ID, rest } from "./discord.service";
import { currentSeason } from "./saison.service";
import { ensureProject } from "./world.service";

/* ============================================================
   /stats (2.1) : le tableau de bord du staff, sur Discord.

   Ce que le jeu sait déjà, sans ouvrir la base : joueurs, activité,
   Premium, ventes de la boutique, communauté Discord, saison et chantier.
   Réponse visible par le seul membre du staff qui l'a demandée.
   ============================================================ */

const DAY = 86_400_000;
const euros = (cents: number) => `${(cents / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : "—");

export async function staffStats(): Promise<Embed> {
  const [d1, d7, d30] = [ago(1), ago(7), ago(30)];

  const [
    companies, new1, new7, active1, active7,
    premiumPaid, premiumTrials, premiumBought7, premiumBought30,
    shop7, shop30, linked, openGiveaways,
  ] = await Promise.all([
    prisma.company.count(),
    prisma.company.count({ where: { createdAt: { gte: d1 } } }),
    prisma.company.count({ where: { createdAt: { gte: d7 } } }),
    prisma.company.count({ where: { lastActiveAt: { gte: d1 } } }),
    prisma.company.count({ where: { lastActiveAt: { gte: d7 } } }),
    prisma.company.count({ where: { isPremium: true, premiumTrialUntil: null } }),
    prisma.company.count({ where: { premiumTrialUntil: { not: null } } }),
    // un Premium payé laisse une transaction « Statut Premium activé » ou « Premium offert par … »
    prisma.transaction.count({ where: { type: "PREMIUM", createdAt: { gte: d7 }, NOT: { description: { startsWith: "Cadeau de" } } } }),
    prisma.transaction.count({ where: { type: "PREMIUM", createdAt: { gte: d30 }, NOT: { description: { startsWith: "Cadeau de" } } } }),
    // achats réels de la boutique (pass, extensions, objets) : les cadeaux du staff sont à 0 €
    prisma.shopPurchase.aggregate({ where: { purchasedAt: { gte: d7 }, amountCents: { gt: 0 } }, _sum: { amountCents: true }, _count: { _all: true } }),
    prisma.shopPurchase.aggregate({ where: { purchasedAt: { gte: d30 }, amountCents: { gt: 0 } }, _sum: { amountCents: true }, _count: { _all: true } }),
    prisma.user.count({ where: { discordId: { not: null } } }),
    prisma.giveaway.count({ where: { endedAt: null } }),
  ]);

  // membres du serveur Discord (approximation fournie par Discord)
  let members: number | null = null;
  if (botEnabled()) {
    const g = await rest<{ approximate_member_count?: number }>("GET", `/guilds/${GUILD_ID}?with_counts=true`).catch(() => null);
    members = g?.approximate_member_count ?? null;
  }

  const fields: NonNullable<Embed["fields"]> = [
    {
      name: "🚂 Compagnies",
      value: `**${fmt(companies)}** au total\n+${fmt(new1)} en 24 h · +${fmt(new7)} en 7 j`,
      inline: true,
    },
    {
      name: "🟢 Joueurs actifs",
      value: `**${fmt(active1)}** en 24 h (${pct(active1, companies)})\n**${fmt(active7)}** en 7 j (${pct(active7, companies)})`,
      inline: true,
    },
    {
      name: "💎 Premium",
      value: `**${fmt(premiumPaid)}** achetés (${pct(premiumPaid, companies)})\n${fmt(premiumTrials)} essai${premiumTrials > 1 ? "s" : ""} en cours\nVentes : ${fmt(premiumBought7)} en 7 j · ${fmt(premiumBought30)} en 30 j`,
      inline: true,
    },
    {
      name: "🛒 Boutique (hors Premium)",
      value: `7 j : **${euros(shop7._sum.amountCents ?? 0)}** · ${fmt(shop7._count._all)} achat${shop7._count._all > 1 ? "s" : ""}\n30 j : **${euros(shop30._sum.amountCents ?? 0)}** · ${fmt(shop30._count._all)} achat${shop30._count._all > 1 ? "s" : ""}`,
      inline: true,
    },
    {
      name: "💬 Discord",
      value: `${members !== null ? `**${fmt(members)}** membres\n` : ""}${fmt(linked)} compte${linked > 1 ? "s" : ""} lié${linked > 1 ? "s" : ""} (${pct(linked, companies)} des compagnies)\n${openGiveaways} giveaway${openGiveaways > 1 ? "s" : ""} en cours`,
      inline: true,
    },
  ];

  const season = await currentSeason();
  if (season) {
    const players = await prisma.seasonEntry.count({ where: { seasonId: season.id, points: { gt: 0 } } });
    const left = Math.max(0, Math.ceil((season.endsAt.getTime() - Date.now()) / DAY));
    fields.push({ name: "🏆 Saison", value: `${season.name}\n${fmt(players)} compagnie${players > 1 ? "s" : ""} classée${players > 1 ? "s" : ""} · encore ${left} j`, inline: true });
  }
  const world = await ensureProject().catch(() => null);
  if (world) {
    const p = world.completedAt ? 100 : Math.min(100, (world.progress / world.target) * 100);
    fields.push({ name: "🏔️ Grand Chantier", value: world.completedAt ? "Tunnel ouvert" : `${p.toFixed(1).replace(".", ",")} % (${fmt(world.progress)} / ${fmt(world.target)})`, inline: true });
  }

  return {
    title: "Tableau de bord de Réseau",
    color: BRAND_COLOR,
    fields,
    footer: { text: "Visible par vous seul · « actif » = jeu ouvert" },
    timestamp: new Date().toISOString(),
  };
}
