import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { pushEnabled, pushPublicKey, sendToCompany } from "../services/push.service";

async function companyOf(req: AuthRequest) {
  return prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { id: true },
  });
}

/* La clé publique est publique par construction : le navigateur en a besoin
   pour créer l'abonnement. C'est la clé privée qui reste sur le serveur. */
export async function getPushKey(_req: AuthRequest, res: Response) {
  return res.json({ enabled: pushEnabled(), publicKey: pushPublicKey() });
}

export async function subscribePush(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const { endpoint, keys } = req.body ?? {};
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    return res.status(400).json({ error: "Abonnement invalide" });
  }
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    return res.status(400).json({ error: "Clés de chiffrement manquantes" });
  }

  /* upsert sur l'endpoint : un même appareil qui se réabonne ne doit pas créer
     un doublon, et s'il change de compagnie, l'abonnement suit le compte. */
  const saved = await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { p256dh: keys.p256dh, auth: keys.auth, companyId: company.id },
    create: {
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      companyId: company.id,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 200) : null,
    },
  });

  return res.status(201).json({ id: saved.id });
}

export async function unsubscribePush(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const { endpoint } = req.body ?? {};
  if (typeof endpoint !== "string") {
    return res.status(400).json({ error: "Abonnement invalide" });
  }

  await prisma.pushSubscription.deleteMany({ where: { endpoint, companyId: company.id } });
  return res.json({ ok: true });
}

/* Envoi d'essai : le joueur doit pouvoir vérifier lui-même que ça fonctionne,
   sans attendre qu'un cours franchisse un seuil. */
export async function testPush(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  /* L'essai dit ce qui s'est passé au lieu de répondre « ok » quoi qu'il
     arrive : c'est le seul outil du joueur (et le nôtre) pour savoir où ça
     coince. */
  const report = await sendToCompany(company.id, {
    title: "Réseau",
    body: "Les notifications fonctionnent. Vous serez prévenu même jeu fermé.",
    url: "/dashboard",
    tag: "test",
  });

  if (!report) {
    return res.status(503).json({ error: "Les notifications ne sont pas configurées sur le serveur (clés VAPID absentes)" });
  }
  if (report.subscriptions === 0) {
    return res.status(409).json({ error: "Aucun appareil abonné : réactivez les notifications sur cet appareil" });
  }
  if (report.delivered === 0) {
    return res.status(502).json({
      error:
        report.removed > 0
          ? "L'abonnement de cet appareil n'était plus valide et a été supprimé : réactivez les notifications"
          : `Le service de notification a refusé l'envoi (${report.lastError ?? "erreur inconnue"})`,
      report,
    });
  }
  return res.json({ ok: true, ...report });
}

export async function listPushSubscriptions(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const count = await prisma.pushSubscription.count({ where: { companyId: company.id } });
  return res.json({ count, enabled: pushEnabled() });
}
