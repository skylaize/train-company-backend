import { prisma } from "../prisma";

/* ============================================================
   2.6.1 : les nouveaux venus.

   Une compagnie de moins de sept jours qui n'a encore rien livré est une
   nouvelle venue : elle reçoit un contrat de bienvenue réservé sur le marché
   du fret (contract.controller), un wagon plat avec sa première locomotive de
   fret (train.controller), et sa facture d'énergie ne bloque pas ses rames la
   première semaine (energy.service).
   ============================================================ */

export const WELCOME_DAYS = 7;
export const WELCOME_WAGON = "W_PLAT";

export const isYoung = (createdAt: Date | string, now = Date.now()) => now - new Date(createdAt).getTime() <= WELCOME_DAYS * 86_400_000;

export async function isNewcomer(companyId: string, createdAt: Date) {
  if (!isYoung(createdAt)) return false;
  return (await prisma.contract.count({ where: { companyId, status: "LIVREE" } })) === 0;
}
