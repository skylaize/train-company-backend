import { Response } from "express";
import Stripe from "stripe";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { SHOP_ITEMS, findItem, unlockedFor } from "../services/shop.service";

const secretKey = process.env.STRIPE_SECRET_KEY;
const stripe = secretKey ? new Stripe(secretKey) : null;

async function companyOf(req: AuthRequest) {
  return prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { id: true, name: true, emblem: true, title: true, theme: true, liveryColor: true },
  });
}

export async function getShop(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const unlocked = await unlockedFor(company.id);

  return res.json({
    enabled: Boolean(stripe),
    items: SHOP_ITEMS.map((item) => ({ ...item, owned: unlocked.owned.has(item.id) })),
    // ce que la compagnie porte en ce moment, pour cocher le bon choix à l'écran
    equipped: {
      emblem: company.emblem,
      title: company.title,
      theme: company.theme,
      livery: company.liveryColor,
    },
    unlocked: {
      emblems: [...unlocked.emblems],
      titles: [...unlocked.titles],
      themes: [...unlocked.themes],
      liveries: [...unlocked.liveries],
    },
  });
}

/* Paiement d'un objet. Le prix est défini côté serveur, dans le catalogue, et
   transmis à Stripe à la volée : aucun produit à créer à la main dans le
   tableau de bord, et surtout aucun montant fourni par le navigateur. */
export async function createShopCheckout(req: AuthRequest, res: Response) {
  if (!stripe) return res.status(503).json({ error: "La boutique n'est pas encore ouverte" });

  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const item = findItem(String(req.body?.itemId ?? ""));
  if (!item) return res.status(404).json({ error: "Cet objet n'existe pas" });

  const already = await prisma.shopPurchase.findUnique({
    where: { companyId_itemId: { companyId: company.id, itemId: item.id } },
  });
  if (already) return res.status(409).json({ error: "Vous possédez déjà cet objet" });

  const site = process.env.PUBLIC_SITE_URL ?? "https://compagnie.skhost.fr";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: item.priceCents,
            product_data: { name: `${item.name} — Réseau`, description: item.description },
          },
        },
      ],
      client_reference_id: company.id,
      /* « kind: shop » est ce qui distingue cet achat du Premium dans le
         webhook. Sans cette marque, le webhook traiterait tout paiement comme
         un passage au Premium. */
      metadata: { kind: "shop", itemId: item.id, companyId: company.id },
      /* Contenu numérique livré immédiatement : en droit européen, l'acheteur
         doit consentir à l'exécution immédiate, ce qui éteint son droit de
         rétractation. On le lui dit sur la page de paiement elle-même. */
      custom_text: {
        submit: {
          message:
            "Objet cosmétique livré immédiatement dans votre compagnie. En payant, vous demandez cette livraison immédiate et renoncez au délai de rétractation de 14 jours.",
        },
      },
      success_url: `${site}/dashboard?boutique=ok&objet=${encodeURIComponent(item.id)}`,
      cancel_url: `${site}/dashboard?boutique=annule`,
    });

    if (!session.url) return res.status(502).json({ error: "Stripe n'a pas renvoyé de page de paiement" });
    return res.json({ url: session.url });
  } catch (err) {
    const e = err as { message?: string };
    console.error("[boutique] échec de création de la session :", e.message);
    return res.status(502).json({ error: `Stripe a refusé la demande : ${e.message ?? "raison inconnue"}` });
  }
}

/* Livraison d'un objet, appelée par le webhook Stripe une fois le paiement
   confirmé. Idempotente : Stripe peut livrer deux fois le même événement, et
   l'index unique sur la session empêche d'enregistrer l'achat deux fois. */
export async function grantShopItem(session: Stripe.Checkout.Session) {
  const itemId = session.metadata?.itemId;
  const companyId = session.client_reference_id ?? session.metadata?.companyId;
  const item = itemId ? findItem(itemId) : null;
  if (!item || !companyId) return;

  const existing = await prisma.shopPurchase.findUnique({ where: { stripeSessionId: session.id } });
  if (existing) return;

  await prisma.$transaction([
    prisma.shopPurchase.upsert({
      where: { companyId_itemId: { companyId, itemId: item.id } },
      update: {},
      create: {
        companyId,
        itemId: item.id,
        stripeSessionId: session.id,
        amountCents: session.amount_total ?? item.priceCents,
      },
    }),
    prisma.transaction.create({
      data: {
        companyId,
        type: "BOUTIQUE",
        amount: 0,
        description: `Boutique : ${item.name}`,
      },
    }),
  ]);
}
