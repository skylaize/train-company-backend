import { Request, Response } from "express";
import Stripe from "stripe";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { grantShopItem } from "./shop.controller";
import { hasAdFree, AD_FREE_ITEM } from "../services/shop.service";

/* ============================================================
   Paiement du statut Premium, via Stripe Checkout.

   Checkout est une page hébergée par Stripe : aucune donnée de carte ne
   transite par ce serveur, ce qui réduit l'exposition au strict minimum.

   Règle qui structure tout le reste : le statut Premium n'est JAMAIS accordé
   depuis le navigateur. La redirection de succès est une simple page de
   courtoisie — elle peut être ouverte à la main, sans avoir rien payé. Seul
   le webhook signé par Stripe fait autorité.
   ============================================================ */

const secretKey = process.env.STRIPE_SECRET_KEY;
const priceId = process.env.STRIPE_PREMIUM_PRICE_ID;
/* 1.7 : passage au Premium pour qui a déjà le billet sans pub. Second prix
   libre dans Stripe, avec un minimum plus bas (4 €) ; sans lui, le prix normal. */
const upgradePriceId = process.env.STRIPE_PREMIUM_UPGRADE_PRICE_ID;
/* Montants affichés dans le jeu. Ils doivent correspondre aux réglages des prix
   dans Stripe : minimum, et « montant prédéfini » (le prix conseillé, pré-rempli). */
const cents = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
const PRICES = {
  min: cents(process.env.PREMIUM_MIN_CENTS, 599),
  suggested: cents(process.env.PREMIUM_SUGGESTED_CENTS, 799),
  upgradeMin: cents(process.env.PREMIUM_UPGRADE_MIN_CENTS, 400),
  upgradeSuggested: cents(process.env.PREMIUM_UPGRADE_SUGGESTED_CENTS, 599),
};
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

/* Tant que les variables d'environnement ne sont pas renseignées, la vente est
   simplement fermée : le serveur démarre normalement, l'interface continue
   d'afficher « Bientôt disponible ». */
const stripe = secretKey ? new Stripe(secretKey) : null;

export function billingEnabled() {
  return Boolean(stripe && priceId && webhookSecret);
}

export async function getBillingStatus(req: AuthRequest, res: Response) {
  const company = req.userId
    ? ((await prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true } })) as { id: string } | null)
    : null;
  const upgrade = Boolean(company && upgradePriceId && (await hasAdFree(company.id)));
  return res.json({
    enabled: billingEnabled(),
    upgrade,
    minCents: upgrade ? PRICES.upgradeMin : PRICES.min,
    suggestedCents: upgrade ? PRICES.upgradeSuggested : PRICES.suggested,
    adFreeCents: AD_FREE_ITEM.priceCents,
  });
}

export async function createCheckoutSession(req: AuthRequest, res: Response) {
  if (!stripe || !priceId) {
    return res.status(503).json({ error: "La vente n'est pas encore ouverte" });
  }

  const company = await prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { id: true, isPremium: true, name: true },
  });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }
  if (company.isPremium) {
    return res.status(409).json({ error: "Votre compagnie est déjà Premium" });
  }

  const site = process.env.PUBLIC_SITE_URL ?? "https://compagnie.skhost.fr";

  /* Sans ce try/catch, un refus de Stripe — tarif inconnu, clé de test contre
     compte en production, compte non activé — remontait en rejet non
     intercepté : le joueur voyait « une erreur est survenue » et la cause
     n'apparaissait nulle part. Pire, un rejet non intercepté peut arrêter le
     processus Node. On journalise le détail côté serveur et on renvoie au
     joueur un message qui dit au moins d'où vient le problème. */
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment", // achat unique : pas d'abonnement, donc pas de renouvellement à gérer
      // 1.7 : déjà propriétaire du billet sans pub → second prix libre, minimum plus bas
      line_items: [{ price: upgradePriceId && (await hasAdFree(company.id)) ? upgradePriceId : priceId, quantity: 1 }],
      /* C'est par là que le webhook retrouvera la compagnie à créditer. On ne se
         fie pas à l'e-mail : un joueur peut payer avec une autre adresse. */
      client_reference_id: company.id,
      metadata: { companyId: company.id, companyName: company.name },
      success_url: `${site}/dashboard?premium=ok`,
      cancel_url: `${site}/dashboard?premium=annule`,
    });

    if (!session.url) {
      console.error("[stripe] session créée sans URL de paiement", session.id);
      return res.status(502).json({ error: "Stripe n'a pas renvoyé de page de paiement" });
    }

    return res.json({ url: session.url });
  } catch (err) {
    const e = err as { type?: string; code?: string; message?: string };
    console.error("[stripe] échec de création de la session :", e.type, e.code, e.message);
    return res.status(502).json({
      error: `Stripe a refusé la demande : ${e.message ?? "raison inconnue"}`,
    });
  }
}

/* Webhook Stripe. Monté avec express.raw AVANT express.json : la vérification
   de signature porte sur les octets bruts du corps, et un corps déjà décodé
   en JSON invaliderait le calcul. */
export async function handleStripeWebhook(req: Request, res: Response) {
  if (!stripe || !webhookSecret) return res.status(503).end();

  const signature = req.headers["stripe-signature"];
  if (!signature) return res.status(400).send("Signature manquante");

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature as string, webhookSecret);
  } catch (err) {
    // signature invalide : la requête ne vient pas de Stripe
    return res.status(400).send(`Signature invalide : ${(err as Error).message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    /* Achat en boutique : même webhook, autre traitement. La marque « shop »
       est posée par la boutique elle-même ; un paiement Premium n'en porte pas,
       ce qui garde le parcours Premium exactement tel qu'il fonctionnait. */
    if (session.metadata?.kind === "shop") {
      if (session.payment_status === "paid") {
        try {
          await grantShopItem(session);
        } catch (err) {
          /* On répond quand même 200 : un 500 ferait réessayer Stripe pendant
             trois jours, et l'erreur ne disparaîtrait pas pour autant. Le
             journal garde la session pour une livraison à la main. */
          console.error("[boutique] livraison échouée pour la session", session.id, err);
        }
      }
      return res.json({ received: true });
    }

    const companyId = session.client_reference_id ?? session.metadata?.companyId;

    /* Un paiement en attente n'est pas un paiement. Pour un virement ou un
       moyen différé, la session peut être « completed » avant l'encaissement. */
    if (companyId && session.payment_status === "paid") {
      const company = await prisma.company.findUnique({
        where: { id: companyId },
        select: { id: true, isPremium: true },
      });

      /* Stripe peut livrer le même événement plusieurs fois : on ne crédite
         qu'une seule fois, et on répond 200 dans tous les cas pour arrêter
         les tentatives de renvoi. */
      if (company && !company.isPremium) {
        await prisma.$transaction([
          prisma.company.update({ where: { id: company.id }, data: { isPremium: true } }),
          prisma.transaction.create({
            data: {
              companyId: company.id,
              type: "PREMIUM",
              amount: 0,
              description: "Statut Premium activé",
            },
          }),
        ]);
      }
    }
  }

  return res.json({ received: true });
}

