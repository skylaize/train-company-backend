import { findRecipient } from "./shop.controller";
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
  // 2.0 : offrir le Premium à une autre compagnie
  const giftTo = req.body?.giftTo ? await findRecipient(req.body.giftTo) : null;
  if (req.body?.giftTo && !giftTo) return res.status(404).json({ error: "Aucune compagnie ne porte ce nom" });
  if (giftTo && giftTo.id === company.id) return res.status(409).json({ error: "Pour vous-même, achetez sans l'offrir" });
  if (giftTo?.isPremium) return res.status(409).json({ error: `${giftTo.name} est déjà Premium` });
  if (!giftTo && company.isPremium) {
    return res.status(409).json({ error: "Votre compagnie est déjà Premium" });
  }
  const target = giftTo ?? company;

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
      line_items: [{ price: !giftTo && upgradePriceId && (await hasAdFree(company.id)) ? upgradePriceId : priceId, quantity: 1 }],
      /* C'est par là que le webhook retrouvera la compagnie à créditer. On ne se
         fie pas à l'e-mail : un joueur peut payer avec une autre adresse. */
      client_reference_id: target.id,
      metadata: { companyId: target.id, companyName: target.name, ...(giftTo ? { giftFrom: company.name } : {}) },
      success_url: giftTo ? `${site}/dashboard?premium=cadeau&pour=${encodeURIComponent(giftTo.name)}` : `${site}/dashboard?premium=ok&session_id={CHECKOUT_SESSION_ID}`,
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

  /* 2.0 : un moyen de paiement différé (virement, prélèvement) termine la
     session avant l'encaissement ; le Premium arrive alors avec
     « async_payment_succeeded ». Avant, ce second événement était ignoré. */
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    try {
      await processCheckoutSession(event.data.object as Stripe.Checkout.Session);
    } catch (err) {
      /* On répond quand même 200 : un 500 ferait réessayer Stripe pendant trois
         jours. Le rattrapage (reconcilePayments) repassera de toute façon. */
      console.error("[stripe] traitement échoué pour la session", (event.data.object as { id?: string }).id, err);
    }
  }

  return res.json({ received: true });
}

/* ============================================================
   2.0 : un paiement ne doit plus dépendre d'un seul message.

   Avant, seul le webhook activait le Premium ou livrait l'objet. Si Stripe
   n'arrivait pas à le livrer (adresse du webhook restée sur l'ancien
   hébergeur, secret absent, serveur qui redémarre), le joueur avait payé
   pour rien et il fallait l'activer à la main. Désormais, trois chemins
   mènent au même traitement, qui ne crédite jamais deux fois :
   - le webhook, comme avant ;
   - le retour du joueur sur le jeu : on redemande la session à Stripe ;
   - un rattrapage toutes les 10 minutes sur les paiements des 3 derniers jours.
   Dans les trois cas, c'est Stripe (avec la clé secrète) qui dit si c'est
   payé : le navigateur ne peut toujours rien accorder.
   ============================================================ */
export async function processCheckoutSession(session: Stripe.Checkout.Session) {
  if (session.payment_status !== "paid") return { done: false as const, reason: "non payé" };

  if (session.metadata?.kind === "shop") {
    await grantShopItem(session);
    return { done: true as const, kind: "shop" as const };
  }

  const companyId = session.client_reference_id ?? session.metadata?.companyId;
  if (!companyId) return { done: false as const, reason: "compagnie inconnue" };
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, isPremium: true } });
  if (!company) return { done: false as const, reason: "compagnie introuvable" };
  if (company.isPremium) return { done: true as const, kind: "premium" as const };

  // la ligne n'est prise qu'une fois, même si le webhook et le rattrapage passent en même temps
  const granted = await prisma.company.updateMany({
    where: { id: company.id, isPremium: false },
    data: { isPremium: true, premiumReveal: session.metadata?.giftFrom ?? "" },
  });
  if (granted.count) {
    await prisma.transaction.create({
      data: {
        companyId: company.id,
        type: "PREMIUM",
        amount: 0,
        description: session.metadata?.giftFrom ? `Premium offert par ${session.metadata.giftFrom}` : "Statut Premium activé",
      },
    });
    console.log("[stripe] Premium activé pour", company.id, "session", session.id);
  }
  return { done: true as const, kind: "premium" as const };
}

/* Retour du joueur après paiement : ?premium=ok&session_id=cs_… */
export async function confirmCheckout(req: AuthRequest, res: Response) {
  if (!stripe) return res.status(503).json({ error: "Paiement indisponible" });
  const sessionId = String(req.body?.sessionId ?? "");
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return res.status(400).json({ error: "Session inconnue" });
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true } });
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    return res.status(404).json({ error: "Session inconnue" });
  }
  // seul celui qui a payé (ou celui qui reçoit) peut demander le traitement de sa session
  const mine = session.client_reference_id === company.id || session.metadata?.companyId === company.id || session.metadata?.buyerId === company.id;
  if (!mine) return res.status(403).json({ error: "Cette session ne vous appartient pas" });
  try {
    const r = await processCheckoutSession(session);
    return res.json({ ok: r.done, status: session.payment_status });
  } catch (err) {
    console.error("[stripe] confirmation échouée", sessionId, err);
    return res.status(500).json({ error: "Le paiement est enregistré, l'activation reprendra d'elle-même" });
  }
}

/* Rattrapage : toutes les 10 minutes, les sessions payées des trois derniers
   jours repassent dans le traitement (sans effet si c'est déjà fait). */
let lastReconcile = 0;
export async function reconcilePayments(now = Date.now()) {
  if (!stripe || now - lastReconcile < 10 * 60_000) return 0;
  lastReconcile = now;
  let fixed = 0;
  const since = Math.floor((now - 3 * 86_400_000) / 1000);
  for await (const session of stripe.checkout.sessions.list({ created: { gte: since }, status: "complete", limit: 100 })) {
    if (session.payment_status !== "paid") continue;
    try {
      const before = await alreadyDelivered(session);
      if (before) continue;
      const r = await processCheckoutSession(session);
      if (r.done) {
        fixed++;
        console.warn("[stripe] rattrapage : session", session.id, "livrée sans webhook");
      }
    } catch (err) {
      console.error("[stripe] rattrapage échoué pour", session.id, (err as Error).message);
    }
  }
  return fixed;
}

async function alreadyDelivered(session: Stripe.Checkout.Session) {
  if (session.metadata?.kind === "shop") {
    if (await prisma.shopPurchase.findUnique({ where: { stripeSessionId: session.id } })) return true;
    const target = session.client_reference_id ?? session.metadata?.companyId;
    const itemId = session.metadata?.itemId;
    if (!target || !itemId) return true;
    return Boolean(await prisma.shopPurchase.findUnique({ where: { companyId_itemId: { companyId: target, itemId } } }));
  }
  const companyId = session.client_reference_id ?? session.metadata?.companyId;
  if (!companyId) return true;
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { isPremium: true } });
  return !c || c.isPremium;
}

