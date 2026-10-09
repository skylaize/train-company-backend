import { Response } from "express";
import Stripe from "stripe";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { SHOP_ITEMS, findItem, unlockedFor, dailyRotation, inShopToday } from "../services/shop.service";
import { activeSeasonalEvent, nextEdition, seasonalEventById } from "../services/season.service";
import { currentPassItem, passSeasonNumber } from "../services/pass.service";
import { sendToCompany } from "../services/push.service";

/* 2.0 : offrir. Le destinataire est désigné par le nom de sa compagnie. */
export async function findRecipient(name: unknown) {
  const clean = String(name ?? "").trim();
  if (!clean) return null;
  return prisma.company.findFirst({
    where: { name: { equals: clean, mode: "insensitive" } },
    select: { id: true, name: true, isPremium: true },
  });
}

const secretKey = process.env.STRIPE_SECRET_KEY;
const stripe = secretKey ? new Stripe(secretKey) : null;

async function companyOf(req: AuthRequest) {
  return prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { id: true, name: true, emblem: true, title: true, theme: true, liveryColor: true, cabSkin: true, plate: true },
  });
}

export async function getShop(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const unlocked = await unlockedFor(company.id);
  const isPremium = Boolean((await prisma.company.findUnique({ where: { id: company.id }, select: { isPremium: true } }))?.isPremium);

  return res.json({
    enabled: Boolean(stripe),
    /* Les éditions de saison n'apparaissent que pendant leur temps fort, ou
       chez ceux qui les possèdent déjà. Les autres savent seulement quand
       revient la prochaine. */
    items: SHOP_ITEMS.filter((item) => !item.season || item.season === activeSeasonalEvent()?.id || unlocked.owned.has(item.id)).map((item) => {
      const ev = item.season ? seasonalEventById(item.season) : null;
      const active = ev && activeSeasonalEvent()?.id === ev.id;
      return { ...item, owned: unlocked.owned.has(item.id), includedInPremium: Boolean(item.dlc?.premium && isPremium), availableUntil: active ? nextEdition(ev!).end : null, seasonName: ev?.name ?? null };
    }),
    // 2.0 : la boutique du jour
    rotation: dailyRotation(),
    // 2.0 : le pass de la saison en cours
    pass: await (async () => {
      const p = await currentPassItem();
      return p ? { ...p, owned: unlocked.owned.has(p.id) } : null;
    })(),
    nextSeason: (() => {
      if (activeSeasonalEvent()) return null;
      const upcoming = SHOP_ITEMS.filter((i) => i.season).map((i) => ({ item: i, ev: seasonalEventById(i.season!)! }))
        .map(({ item, ev }) => ({ name: ev.name, itemName: item.name, startsAt: nextEdition(ev).start }))
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      return upcoming[0] ?? null;
    })(),
    // ce que la compagnie porte en ce moment, pour cocher le bon choix à l'écran
    equipped: {
      emblem: company.emblem,
      title: company.title,
      theme: company.theme,
      livery: company.liveryColor,
      cabSkin: (company as { cabSkin?: string | null }).cabSkin ?? null,
      plate: (company as { plate?: string | null }).plate ?? null,
    },
    unlocked: {
      emblems: [...unlocked.emblems],
      titles: [...unlocked.titles],
      themes: [...unlocked.themes],
      liveries: [...unlocked.liveries],
      cabSkins: [...unlocked.cabSkins],
      plates: [...unlocked.plates],
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
  // 2.0 : un pass ne se vend que pendant sa saison
  if (passSeasonNumber(item.id) !== null) {
    const current = await currentPassItem();
    if (!current || current.id !== item.id) return res.status(410).json({ error: "Ce pass n'est plus en vente : sa saison est terminée" });
    Object.assign(item, { name: current.name, description: current.description });
  }

  // 2.0 : la boutique du jour — un objet de la rotation n'est en vente que le jour où il y figure
  if (!inShopToday(item.id)) return res.status(410).json({ error: "Cet objet n'est plus en boutique aujourd'hui. Il reviendra dans quelques jours." });

  // 2.0 : offrir à une autre compagnie
  const giftTo = req.body?.giftTo ? await findRecipient(req.body.giftTo) : null;
  if (req.body?.giftTo && !giftTo) return res.status(404).json({ error: "Aucune compagnie ne porte ce nom" });
  if (giftTo && giftTo.id === company.id) return res.status(409).json({ error: "Pour vous-même, achetez sans l'offrir" });
  const target = giftTo ?? company;
  if (item.season && activeSeasonalEvent()?.id !== item.season) {
    return res.status(410).json({ error: "Cette édition limitée n'est plus en vente. Elle reviendra à sa saison." });
  }

  if (item.kind === "DLC" && item.dlc?.premium) {
    const prem = await prisma.company.findUnique({ where: { id: target.id }, select: { isPremium: true } });
    if (prem?.isPremium) return res.status(409).json({ error: giftTo ? `${giftTo.name} a déjà cette extension avec son Premium` : "Cette extension est déjà incluse dans votre Premium" });
  }
  if (item.kind === "SANS_PUB" && (giftTo ? giftTo.isPremium : (company as { isPremium?: boolean }).isPremium)) {
    return res.status(409).json({ error: "Le Premium n'affiche déjà aucune publicité" });
  }

  const already = await prisma.shopPurchase.findUnique({
    where: { companyId_itemId: { companyId: target.id, itemId: item.id } },
  });
  if (already) return res.status(409).json({ error: giftTo ? `${giftTo.name} possède déjà cet objet` : "Vous possédez déjà cet objet" });

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
            product_data: { name: `${giftTo ? "Cadeau : " : ""}${item.name} — Réseau`, description: giftTo ? `Offert à ${giftTo.name}. ${item.description}` : item.description },
          },
        },
      ],
      client_reference_id: target.id,
      /* « kind: shop » est ce qui distingue cet achat du Premium dans le
         webhook. Sans cette marque, le webhook traiterait tout paiement comme
         un passage au Premium. */
      metadata: { kind: "shop", itemId: item.id, companyId: target.id, ...(giftTo ? { giftFrom: company.name, buyerId: company.id } : {}) },
      /* Contenu numérique livré immédiatement : en droit européen, l'acheteur
         doit consentir à l'exécution immédiate, ce qui éteint son droit de
         rétractation. On le lui dit sur la page de paiement elle-même. */
      custom_text: {
        submit: {
          message:
            "Contenu numérique livré immédiatement dans votre compagnie. En payant, vous demandez cette livraison immédiate et renoncez au délai de rétractation de 14 jours.",
        },
      },
      success_url: giftTo ? `${site}/dashboard?boutique=cadeau&pour=${encodeURIComponent(giftTo.name)}` : `${site}/dashboard?boutique=ok&objet=${encodeURIComponent(item.id)}&session_id={CHECKOUT_SESSION_ID}`,
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
  // 2.0 : déjà possédé (un cadeau en double, ou une session repassée par le rattrapage) : rien à refaire
  const owned = await prisma.shopPurchase.findUnique({ where: { companyId_itemId: { companyId, itemId: item.id } } });
  if (owned) return;

  await prisma.$transaction([
    prisma.shopPurchase.upsert({
      where: { companyId_itemId: { companyId, itemId: item.id } },
      update: {},
      create: {
        companyId,
        itemId: item.id,
        stripeSessionId: session.id,
        amountCents: session.amount_total ?? item.priceCents,
        giftFrom: session.metadata?.giftFrom ?? null,
      },
    }),
    prisma.transaction.create({
      data: {
        companyId,
        type: "BOUTIQUE",
        amount: 0,
        description: session.metadata?.giftFrom ? `Cadeau de ${session.metadata.giftFrom} : ${item.name}` : `Boutique : ${item.name}`,
      },
    }),
  ]);
  // 2.0 : le destinataire d'un cadeau est prévenu
  if (session.metadata?.giftFrom) {
    void sendToCompany(companyId, { title: "Vous avez reçu un cadeau", body: `${session.metadata.giftFrom} vous offre : ${item.name}.`, url: "/dashboard", tag: "cadeau" });
  }
}

/* 2.0 : le déballage. Ce qui a été livré (acheté ou offert) et dont le joueur
   n'a pas encore vu l'animation, sur n'importe quel appareil. */
export async function getReveals(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true, premiumReveal: true } });
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const rows = await prisma.shopPurchase.findMany({
    where: { companyId: company.id, revealedAt: null },
    orderBy: { purchasedAt: "asc" },
    take: 10,
  });
  const items = rows
    .map((r) => {
      const item = findItem(r.itemId);
      return item ? { purchaseId: r.id, giftFrom: r.giftFrom, item: { ...item, owned: true } } : null;
    })
    .filter(Boolean);
  return res.json({ items, premium: company.premiumReveal === null ? null : { giftFrom: company.premiumReveal || null } });
}

export async function markRevealed(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true } });
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const ids = Array.isArray(req.body?.purchaseIds) ? (req.body.purchaseIds as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 20) : [];
  if (ids.length) await prisma.shopPurchase.updateMany({ where: { id: { in: ids }, companyId: company.id }, data: { revealedAt: new Date() } });
  if (req.body?.premium === true) await prisma.company.update({ where: { id: company.id }, data: { premiumReveal: null } });
  return res.json({ ok: true });
}
