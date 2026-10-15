import { prisma } from "../prisma";
import { sendToCompany } from "./push.service";
import { syncCompany } from "./discord-roles.service";
import { LIVERY_PREMIUM } from "../controllers/company.controller";

/* ============================================================
   Premium d'essai (2.1).

   Offert par le staff (/donner, /giveaway), jamais vendu. Pendant l'essai,
   la compagnie est Premium comme une autre (isPremium = true) : toutes les
   vérifications existantes s'appliquent sans changement. À la date de fin,
   elle repasse en compte gratuit, sauf si le joueur a acheté entre-temps
   (l'achat efface premiumTrialUntil, voir billing.controller).

   Un essai offert à une compagnie déjà en essai le prolonge. Un Premium
   acheté n'est jamais touché.
   ============================================================ */

export const MAX_TRIAL_DAYS = 30;
const DAY_MS = 86_400_000;

export type TrialResult = { ok: true; until: Date } | { ok: false; reason: string };

export async function grantTrial(companyId: string, days: number): Promise<TrialResult> {
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { isPremium: true, premiumTrialUntil: true } });
  if (!c) return { ok: false, reason: "compagnie introuvable" };
  if (c.isPremium && !c.premiumTrialUntil) return { ok: false, reason: "est déjà Premium (acheté)" };
  const from = Math.max(Date.now(), c.premiumTrialUntil?.getTime() ?? 0);
  const until = new Date(from + days * DAY_MS);
  // seulement si le Premium n'a pas été acheté entre-temps
  const done = await prisma.company.updateMany({
    where: { id: companyId, OR: [{ isPremium: false }, { premiumTrialUntil: { not: null } }] },
    data: { isPremium: true, premiumTrialUntil: until, premiumTrialEndedAt: null },
  });
  if (!done.count) return { ok: false, reason: "est déjà Premium (acheté)" };
  void syncCompany(companyId).catch(() => undefined);
  return { ok: true, until };
}

/* À chaque passage : les essais arrivés à leur terme. */
export async function runTrialExpiry() {
  const now = new Date();
  const ending = (await prisma.company.findMany({
    where: { premiumTrialUntil: { lte: now } },
    select: { id: true, liveryColor: true },
  })) as { id: string; liveryColor: string }[];
  for (const c of ending) {
    // seulement si l'essai est toujours là (un achat de dernière minute l'a effacé)
    const ended = await prisma.company.updateMany({
      where: { id: c.id, premiumTrialUntil: { lte: now } },
      data: {
        isPremium: false,
        premiumTrialUntil: null,
        premiumTrialEndedAt: now,
        // la palette Premium n'est plus permise : retour à la livrée d'origine
        ...(LIVERY_PREMIUM.includes(c.liveryColor.toLowerCase()) ? { liveryColor: "#f2a900" } : {}),
      },
    });
    if (!ended.count) continue;
    void sendToCompany(c.id, {
      title: "Votre essai Premium est terminé",
      body: "Il vous a plu ? Gardez la vue cabine, la veille concurrentielle et tout le reste : le Premium s'achète une fois, pour toujours.",
      url: "/dashboard",
      tag: "premium-essai",
    });
    void syncCompany(c.id).catch(() => undefined);
  }
  return ending.length;
}
