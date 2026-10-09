import { Response } from "express";
import bcrypt from "bcrypt";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

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

  const company = await prisma.company.findUnique({ where: { ownerId: userId } });

  if (company) {
    const trains = await prisma.train.findMany({ where: { companyId: company.id }, select: { id: true } });
    const trainIds = trains.map((t) => t.id);

    // suppression en cascade manuelle, dans l'ordre qui respecte les contraintes de clé étrangère
    await prisma.$transaction([
      prisma.incident.deleteMany({ where: { trainId: { in: trainIds } } }),
      prisma.contract.deleteMany({ where: { OR: [{ companyId: company.id }, { trainId: { in: trainIds } }] } }),
      prisma.transaction.deleteMany({ where: { companyId: company.id } }),
      prisma.dailyChallenge.deleteMany({ where: { companyId: company.id } }),
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
      prisma.workshop.deleteMany({ where: { companyId: company.id } }),
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
