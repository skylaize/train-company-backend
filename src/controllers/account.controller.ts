import { Response } from "express";
import bcrypt from "bcrypt";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { forgetDiscord } from "./discord.controller";
import { heldByIssuer, marketPrice } from "../services/finance.service";
import { sendToCompany } from "../services/push.service";

async function buyBackShares(company: { id: string; name: string; sharePrice: number }) {
  const holders = (await prisma.shareholding.findMany({ where: { issuerId: company.id, shares: { gt: 0 } } })) as { holderId: string; shares: number }[];
  if (!holders.length) return;
  const held = (await heldByIssuer()).get(company.id) ?? 0;
  const price = marketPrice(Math.max(0, company.sharePrice ?? 0), held);
  await prisma.$transaction(
    holders.flatMap((h) => {
      const amount = Math.floor(h.shares * price);
      return [
        prisma.company.update({ where: { id: h.holderId }, data: { balance: { increment: amount } } }),
        prisma.transaction.create({ data: { companyId: h.holderId, type: "BOURSE", amount, description: `Rachat de ${h.shares} action${h.shares > 1 ? "s" : ""} ${company.name} : la compagnie a quitté le réseau` } }),
      ];
    })
  );
  for (const h of holders) {
    void sendToCompany(h.holderId, { title: `${company.name} a quitté le réseau`, body: `Vos ${h.shares} action${h.shares > 1 ? "s" : ""} vous sont remboursées au cours du jour.`, url: "/dashboard", tag: "bourse" }).catch(() => {});
  }
}

export async function changePassword(req: AuthRequest, res: Response) {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword et newPassword sont requis" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "Le nouveau mot de passe doit contenir au moins 6 caractères" });
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId as string } });
  if (!user) {
    return res.status(404).json({ error: "Utilisateur introuvable" });
  }

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) {
    return res.status(401).json({ error: "Mot de passe actuel incorrect" });
  }

  const hashed = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { password: hashed } });

  return res.json({ success: true });
}

export async function deleteAccount(req: AuthRequest, res: Response) {
  const userId = req.userId as string;
  // 2.1 : les rôles Discord du jeu partent avec le compte
  await forgetDiscord(userId);

  const company = await prisma.company.findUnique({ where: { ownerId: userId } });

  if (company) {
    /* 2.7 : les actionnaires de la compagnie supprimée sont remboursés au
       cours du moment. Avant, leurs actions disparaissaient sans rien. */
    await buyBackShares(company as { id: string; name: string; sharePrice: number }).catch((e) => console.error("[bourse] rachat à la suppression :", (e as Error).message));
    const trains = await prisma.train.findMany({ where: { companyId: company.id }, select: { id: true } });
    const trainIds = trains.map((t) => t.id);

    // suppression en cascade manuelle, dans l'ordre qui respecte les contraintes de clé étrangère
    await prisma.$transaction([
      prisma.incident.deleteMany({ where: { trainId: { in: trainIds } } }),
      prisma.contract.deleteMany({ where: { OR: [{ companyId: company.id }, { trainId: { in: trainIds } }] } }),
      prisma.transaction.deleteMany({ where: { companyId: company.id } }),
      prisma.dailyChallenge.deleteMany({ where: { companyId: company.id } }),
      // 2.5 : campagnes et compagnonnage (sans clé étrangère)
      prisma.regionCampaign.deleteMany({ where: { companyId: company.id } }),
      prisma.mentorship.updateMany({ where: { endedAt: null, OR: [{ mentorId: company.id }, { apprenticeId: company.id }] }, data: { endedAt: new Date(), endReason: "APPRENTI" } }),
      prisma.staff.deleteMany({ where: { companyId: company.id } }),
      prisma.achievementUnlock.deleteMany({ where: { companyId: company.id } }),
      prisma.adWatch.deleteMany({ where: { companyId: company.id } }),
      prisma.tenderBid.deleteMany({ where: { companyId: company.id } }),
      // un marché en cours sans titulaire se referme, sans quoi sa clôture échouerait à chaque tour
      prisma.tender.updateMany({ where: { winnerId: company.id, status: "ATTRIBUE" }, data: { status: "TERMINE", objectiveMet: false } }),
      /* Tout ce qui s'est ajouté depuis la 1.1 : sans ces lignes, la base
         refusait de supprimer la compagnie dès que le joueur avait touché aux
         missions, à l'entrepôt, aux alertes ou à la boutique. */
      prisma.mission.deleteMany({ where: { companyId: company.id } }),
      prisma.clientRelation.deleteMany({ where: { companyId: company.id } }),
      prisma.standingOrder.deleteMany({ where: { companyId: company.id } }),
      prisma.priceAlert.deleteMany({ where: { companyId: company.id } }),
      prisma.stockLot.deleteMany({ where: { companyId: company.id } }),
      prisma.warehouse.deleteMany({ where: { companyId: company.id } }),
      prisma.construction.deleteMany({ where: { companyId: company.id } }),
      prisma.pushSubscription.deleteMany({ where: { companyId: company.id } }),
      prisma.shopPurchase.deleteMany({ where: { companyId: company.id } }),
      prisma.decision.deleteMany({ where: { companyId: company.id } }),
      // 1.7 : infrastructures et finances (actions détenues ET actions de la compagnie chez les autres)
      prisma.stationOwnership.deleteMany({ where: { companyId: company.id } }),
      // 2.6
      prisma.stationShop.deleteMany({ where: { companyId: company.id } }),
      prisma.stationWatch.deleteMany({ where: { companyId: company.id } }),
      prisma.dailyBalance.deleteMany({ where: { companyId: company.id } }),
      prisma.workshop.deleteMany({ where: { companyId: company.id } }),
      prisma.yard.deleteMany({ where: { companyId: company.id } }),
      prisma.customAlert.deleteMany({ where: { companyId: company.id } }),
      prisma.loan.deleteMany({ where: { companyId: company.id } }),
      prisma.shareholding.deleteMany({ where: { OR: [{ holderId: company.id }, { issuerId: company.id }] } }),
      prisma.sharePrice.deleteMany({ where: { companyId: company.id } }),
      prisma.stockOrder.deleteMany({ where: { OR: [{ companyId: company.id }, { issuerId: company.id }] } }),
      prisma.lineLoadHour.deleteMany({ where: { companyId: company.id } }),
      // 2.0
      prisma.seasonEntry.deleteMany({ where: { companyId: company.id } }),
      prisma.seasonObjectiveProgress.deleteMany({ where: { companyId: company.id } }),
      prisma.allianceMember.deleteMany({ where: { companyId: company.id } }),
      prisma.allianceInvite.deleteMany({ where: { companyId: company.id } }),
      prisma.allianceApplication.deleteMany({ where: { companyId: company.id } }),
      prisma.allianceMessage.deleteMany({ where: { companyId: company.id } }),
      prisma.worldContribution.deleteMany({ where: { companyId: company.id } }),
      prisma.decisionFollowUp.deleteMany({ where: { companyId: company.id } }),
      prisma.seasonPassClaim.deleteMany({ where: { companyId: company.id } }),
      prisma.wreck.deleteMany({ where: { companyId: company.id } }),
      // si cette compagnie a parrainé d'autres joueurs, on détache la référence plutôt que
      // de les impacter (ils gardent leur historique, juste sans parrain associé)
      prisma.company.updateMany({ where: { referredById: company.id }, data: { referredById: null } }),
      prisma.train.deleteMany({ where: { companyId: company.id } }),
      prisma.line.deleteMany({ where: { companyId: company.id } }),
      prisma.company.delete({ where: { id: company.id } }),
    ]);
  }

  await prisma.user.delete({ where: { id: userId } });

  return res.json({ success: true });
}
