import { prisma } from "../prisma";
import { botEnabled, BRAND_COLOR, esc, postOnce } from "./discord.service";
import { sendToCompany } from "./push.service";

/* ============================================================
   Les boosters du serveur Discord (2.3).

   Un joueur qui a lié son compte Discord et qui booste le serveur (Nitro)
   reçoit, sans rien faire :
   - le badge « Booster » à côté du nom de sa compagnie ;
   - la livrée « Nitro » et l'emblème du cristal, tant que le boost dure ;
   - au bout de 90 jours de boost (cumulés), livrée et emblème pour toujours ;
   - au bout de 180 jours, le titre « Mécène du Réseau ».
   Et un merci public : un message dans #général et une ligne dans la Gazette.

   Rien qui rende plus fort : que du cosmétique.

   Qui booste ? Discord le dit dans premium_since, sur la fiche du membre.
   Le passage des rôles (toutes les cinq minutes) la lit déjà ; le gateway
   prévient en plus tout de suite quand un boost commence ou s'arrête.
   ============================================================ */

export const BOOST_LIVERY = "#c04fd6"; // « Nitro »
export const BOOST_EMBLEM = "cristal";
export const BOOST_TITLE = "Mécène du Réseau";
export const BOOST_KEEP_DAYS = 90; // livrée et emblème acquis pour toujours
export const BOOST_TITLE_DAYS = 180;

const DAY_MS = 86_400_000;
const daysBetween = (a: Date, b: Date) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / DAY_MS));

type BoostRow = { id: string; discordId: string | null; boostSince: Date | null; boostDays: number; company: { id: string; name: string; emblem: string | null; liveryColor: string } | null };
const SELECT = { id: true, discordId: true, boostSince: true, boostDays: true, company: { select: { id: true, name: true, emblem: true, liveryColor: true } } };

export function totalDays(u: { boostSince: Date | null; boostDays: number }, now = new Date()) {
  return u.boostDays + (u.boostSince ? daysBetween(u.boostSince, now) : 0);
}

/* Ce que le boost (en cours ou passé) donne à porter. */
export function boostUnlocks(u: { boostSince: Date | null; boostDays: number } | null, now = new Date()) {
  const out = { liveries: [] as string[], emblems: [] as string[], titles: [] as string[] };
  if (!u) return out;
  const days = totalDays(u, now);
  if (u.boostSince || days >= BOOST_KEEP_DAYS) {
    out.liveries.push(BOOST_LIVERY);
    out.emblems.push(BOOST_EMBLEM);
  }
  if (days >= BOOST_TITLE_DAYS) out.titles.push(BOOST_TITLE);
  return out;
}

export async function boostUnlocksFor(companyId: string) {
  const c = (await prisma.company.findUnique({ where: { id: companyId }, select: { owner: { select: { boostSince: true, boostDays: true } } } })) as { owner: { boostSince: Date | null; boostDays: number } | null } | null;
  return boostUnlocks(c?.owner ?? null);
}

/* Les compagnies qui boostent en ce moment, pour les badges (une minute de cache). */
let cache: { at: number; ids: Set<string> } | null = null;
export async function boosterCompanyIds() {
  if (cache && Date.now() - cache.at < 60_000) return cache.ids;
  const rows = (await prisma.user.findMany({ where: { boostSince: { not: null }, discordId: { not: null } }, select: { company: { select: { id: true } } } })) as { company: { id: string } | null }[];
  cache = { at: Date.now(), ids: new Set(rows.map((r) => r.company?.id).filter(Boolean) as string[]) };
  return cache.ids;
}

/* Le statut, pour la page des Paramètres. */
export async function boostStatus(userId: string) {
  const u = (await prisma.user.findUnique({ where: { id: userId }, select: SELECT })) as BoostRow | null;
  if (!u) return null;
  const days = totalDays(u);
  return {
    boosting: Boolean(u.boostSince),
    since: u.boostSince,
    days,
    keepAt: BOOST_KEEP_DAYS,
    titleAt: BOOST_TITLE_DAYS,
    kept: days >= BOOST_KEEP_DAYS,
    title: days >= BOOST_TITLE_DAYS,
    livery: BOOST_LIVERY,
    emblem: BOOST_EMBLEM,
    titleName: BOOST_TITLE,
  };
}

/* Enregistre ce que Discord dit du membre. premiumSince = null : il ne booste
   pas (ou plus). Sans effet si rien n'a changé. */
export async function recordBoost(discordId: string, premiumSince: Date | null, now = new Date()) {
  const u = (await prisma.user.findUnique({ where: { discordId }, select: SELECT })) as BoostRow | null;
  if (!u) return;
  const was = u.boostSince;
  if (premiumSince && premiumSince.getTime() > now.getTime()) premiumSince = now;
  if ((was?.getTime() ?? null) === (premiumSince?.getTime() ?? null)) return;

  if (!was && premiumSince) {
    await prisma.user.update({ where: { id: u.id }, data: { boostSince: premiumSince } });
    cache = null;
    await thank(u, premiumSince).catch((err) => console.error("[discord] merci au booster :", (err as Error).message));
    return;
  }
  if (was && premiumSince) {
    // un nouveau boost alors que l'ancien nous a échappé : on compte l'ancien jusqu'au nouveau
    await prisma.user.update({ where: { id: u.id }, data: { boostSince: premiumSince, boostDays: { increment: daysBetween(was, premiumSince) } } });
    return;
  }
  // fin du boost
  const total = u.boostDays + daysBetween(was!, now);
  await prisma.user.update({ where: { id: u.id }, data: { boostSince: null, boostDays: total } });
  cache = null;
  if (u.company && total < BOOST_KEEP_DAYS) {
    // pas encore acquis : on range la livrée et l'emblème
    const data: { emblem?: null; liveryColor?: string } = {};
    if (u.company.emblem === BOOST_EMBLEM) data.emblem = null;
    if (u.company.liveryColor.toLowerCase() === BOOST_LIVERY) data.liveryColor = "#f2a900";
    if (Object.keys(data).length) await prisma.company.update({ where: { id: u.company.id }, data });
  }
}

async function thank(u: BoostRow, since: Date) {
  // un merci par boost : la clé porte la date de début
  const key = `boost:${u.discordId}:${since.toISOString().slice(0, 10)}`;
  if (u.company) {
    await sendToCompany(u.company.id, {
      title: "Merci pour le boost !",
      body: "Votre compagnie porte le badge Booster, et la livrée Nitro et l'emblème du cristal vous attendent dans les Paramètres.",
      tag: "boost",
    }).catch(() => undefined);
  }
  if (!botEnabled()) return;
  await postOnce(key, "GENERAL", [
    {
      content: `<@${u.discordId}>`,
      embeds: [
        {
          color: BRAND_COLOR,
          title: "Un boost pour le serveur ! 💎",
          description: u.company
            ? `Merci à <@${u.discordId}> et à la compagnie **${esc(u.company.name)}**, qui roule désormais aux couleurs Nitro.`
            : `Merci à <@${u.discordId}> ! Lie ton compte dans le jeu (Paramètres → *Lier mon Discord*) pour recevoir le badge Booster et la livrée Nitro.`,
        },
      ],
      allowed_mentions: { parse: [], users: [u.discordId!] },
    },
  ]);
}

/* Les merci de la veille, pour la Gazette. */
export async function recentBoosters(now = new Date()) {
  const rows = (await prisma.user.findMany({
    where: { boostSince: { gte: new Date(now.getTime() - DAY_MS) }, company: { isNot: null } },
    select: { company: { select: { name: true } } },
  })) as { company: { name: string } | null }[];
  return rows.map((r) => r.company!.name);
}
