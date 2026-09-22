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
export interface PushReport {
  subscriptions: number;
  delivered: number;
  removed: number; // abonnements morts, supprimés
  failed: number;
  lastError: string | null;
}

export async function sendToCompany(companyId: string, message: PushMessage): Promise<PushReport | null> {
  if (!configured) return null;

  /* Rien de ce qui se passe ici ne doit pouvoir interrompre l'appelant.

     Cette fonction est appelée au milieu de la livraison des chantiers : si
     elle lève — table absente parce qu'une migration n'a pas été jouée, base
     injoignable — le chantier n'est jamais marqué terminé, et le joueur reste
     bloqué sur « mise en service » indéfiniment. Une notification ratée est un
     désagrément ; une progression bloquée est un bug. */
  try {
    return await deliver(companyId, message);
  } catch (err) {
    console.error("[push] envoi abandonné :", (err as Error).message);
    return { subscriptions: 0, delivered: 0, removed: 0, failed: 1, lastError: (err as Error).message };
  }
}

async function deliver(companyId: string, message: PushMessage): Promise<PushReport> {
  const report: PushReport = { subscriptions: 0, delivered: 0, removed: 0, failed: 0, lastError: null };
  const subs = await prisma.pushSubscription.findMany({ where: { companyId } });
  report.subscriptions = subs.length;
  if (subs.length === 0) return report;

  const payload = JSON.stringify(message);

  await Promise.all(
    (subs as { id: string; endpoint: string; p256dh: string; auth: string }[]).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          // une notification de chantier vieille de deux jours ne sert plus à rien
          { TTL: 12 * 3600, urgency: "normal" }
        );
        report.delivered += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        /* 404/410 : abonnement mort (appareil réinitialisé, autorisation
           retirée). 403 : abonnement créé avec d'autres clés VAPID — il ne
           marchera plus jamais, autant le supprimer pour qu'il soit recréé. */
        if (status === 404 || status === 410 || status === 403) {
          report.removed += 1;
          await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
        } else {
          report.failed += 1;
          report.lastError = `${status ?? "?"} ${(err as Error).message}`.slice(0, 200);
          console.error("[push] envoi échoué :", status, (err as Error).message);
        }
      }
    })
  );
  return report;
}
