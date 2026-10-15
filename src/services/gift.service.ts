import crypto from "crypto";
import { prisma } from "../prisma";
import { DISCORD_ITEMS, findDiscordItem } from "./shop.service";
import { sendToCompany } from "./push.service";

/* ============================================================
   Cadeaux du staff (2.1) : ce que /donner et /giveaway livrent dans le jeu.

   Deux sortes de lots, et seulement ceux-là :
   - des pièces, plafonnées pour qu'une faute de frappe ne fausse pas le
     classement ;
   - les exclusivités Discord (shop.service), jamais vendues.
   Rien de ce qui se vend ne peut être donné ici : un cadeau ne doit jamais
   coûter une vente.
   ============================================================ */

// affiché par le déballage : « Cadeau de l'équipe de Réseau »
export const GIFT_FROM = "l'équipe de Réseau";
export const MAX_GIFT_COINS = 10_000;

export type Prize = { kind: "pieces"; amount: number } | { kind: "objet"; itemId: string };

/* Les lots proposés dans les commandes Discord. */
export const PRIZE_CHOICES = [
  { name: "Pièces (préciser le montant)", value: "pieces" },
  ...DISCORD_ITEMS.map((i) => ({ name: i.name.replace(/«\s|\s»/g, '"'), value: i.id })),
];

export function parsePrize(lot: string | undefined, amount: number | undefined): Prize | string {
  if (lot === "pieces") {
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n) || n < 1) return "Précisez le montant de pièces avec l'option « montant ».";
    if (n > MAX_GIFT_COINS) return `${MAX_GIFT_COINS.toLocaleString("fr-FR")} pièces au plus par cadeau.`;
    return { kind: "pieces", amount: n };
  }
  if (lot && findDiscordItem(lot)) return { kind: "objet", itemId: lot };
  return "Lot inconnu.";
}

export function prizeLabel(p: Prize) {
  return p.kind === "pieces" ? `${p.amount.toLocaleString("fr-FR")} pi.` : findDiscordItem(p.itemId)?.name ?? p.itemId;
}

export type GiftResult = { ok: true; label: string } | { ok: false; reason: string };

/* La compagnie d'un compte Discord lié, ou la raison pour laquelle il n'y en a pas. */
export async function companyForDiscord(discordId: string): Promise<{ error: string } | { company: { id: string; name: string } }> {
  const user = await prisma.user.findUnique({ where: { discordId }, select: { company: { select: { id: true, name: true } } } });
  if (!user) return { error: "n'a pas lié son compte Réseau (Paramètres → Lier mon Discord)" };
  if (!user.company) return { error: "n'a pas encore fondé sa compagnie" };
  return { company: user.company };
}

/* Livre un lot. `reason` apparaît dans l'historique du joueur et la notification. */
export async function grantPrize(companyId: string, prize: Prize, reason: string): Promise<GiftResult> {
  if (prize.kind === "pieces") {
    await prisma.$transaction([
      prisma.company.update({ where: { id: companyId }, data: { balance: { increment: prize.amount } } }),
      prisma.transaction.create({ data: { companyId, type: "CADEAU", amount: prize.amount, description: `Cadeau de ${GIFT_FROM} : ${reason}` } }),
    ]);
    void sendToCompany(companyId, { title: "Vous avez reçu un cadeau", body: `L'équipe de Réseau vous offre ${prizeLabel(prize)} (${reason}).`, url: "/dashboard", tag: "cadeau" });
    return { ok: true, label: prizeLabel(prize) };
  }

  const item = findDiscordItem(prize.itemId);
  if (!item) return { ok: false, reason: "objet inconnu" };
  const owned = await prisma.shopPurchase.findUnique({ where: { companyId_itemId: { companyId, itemId: item.id } } });
  if (owned) return { ok: false, reason: `possède déjà ${item.name}` };
  await prisma.$transaction([
    prisma.shopPurchase.create({
      data: {
        companyId,
        itemId: item.id,
        // pas de paiement : une référence unique, reconnaissable dans la base
        stripeSessionId: `staff:${crypto.randomUUID()}`,
        amountCents: 0,
        giftFrom: GIFT_FROM,
      },
    }),
    prisma.transaction.create({ data: { companyId, type: "BOUTIQUE", amount: 0, description: `Cadeau de ${GIFT_FROM} : ${item.name} (${reason})` } }),
  ]);
  void sendToCompany(companyId, { title: "Vous avez reçu un cadeau", body: `L'équipe de Réseau vous offre : ${item.name}. Ouvrez le jeu pour le déballer.`, url: "/dashboard", tag: "cadeau" });
  return { ok: true, label: item.name };
}
