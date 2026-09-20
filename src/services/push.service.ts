import webpush from "web-push";
import { prisma } from "../prisma";

/* ============================================================
   Notifications push.

   Ce que ça corrige : une alerte de cours qui n'arrive que si le joueur est
   déjà devant la page des cours ne prévient personne. Elle ne valait rien,
   puisque tout son intérêt est de se déclencher quand on ne regarde pas.

   Ici, le serveur pousse la notification vers le navigateur du joueur, via le
   service de son constructeur (Google, Mozilla, Apple). Elle arrive jeu fermé,
   onglet fermé, et sur téléphone même écran verrouillé.

   Le chiffrement est de bout en bout : le contenu est chiffré avec les clés
   fournies par le navigateur à l'abonnement, et le service qui l'achemine ne
   peut pas le lire.
   ============================================================ */

const publicKey = process.env.VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;
/* Adresse de contact exigée par la norme : c'est par là que les services de
   notification préviennent en cas d'abus. Une adresse e-mail suffit. */
const subject = process.env.VAPID_SUBJECT ?? "mailto:contact@skhost.fr";

let configured = false;
if (publicKey && privateKey) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
} else {
  console.warn("[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY absentes : notifications désactivées");
}

export function pushEnabled() {
  return configured;
}

export function pushPublicKey() {
  return publicKey ?? null;
}

export interface PushMessage {
  title: string;
  body: string;
  /* Page à ouvrir au clic. Relative, résolue côté navigateur contre l'origine
     du site — on ne code pas le domaine en dur ici. */
  url?: string;
  /* Deux notifications de même étiquette se remplacent au lieu de s'empiler :
     dix alertes sur l'acier ne doivent pas faire dix bannières. */
  tag?: string;
}

/* Envoi à tous les appareils d'une compagnie. Les abonnements morts — appareil
   réinitialisé, autorisation retirée, navigateur désinstallé — répondent 404 ou
   410 : on les supprime au lieu de réessayer indéfiniment. */
export async function sendToCompany(companyId: string, message: PushMessage) {
  if (!configured) return;

  const subs = await prisma.pushSubscription.findMany({ where: { companyId } });
  if (subs.length === 0) return;

  const payload = JSON.stringify(message);

  await Promise.all(
    (subs as { id: string; endpoint: string; p256dh: string; auth: string }[]).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
        } else {
          console.error("[push] envoi échoué :", status, (err as Error).message);
        }
      }
    })
  );
}
