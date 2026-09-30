import { Request, Response } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma";
import { mailEnabled, sendMail } from "../services/mail.service";

const JWT_SECRET = process.env.JWT_SECRET as string;
// secret distinct pour le paramètre « state » d'OAuth : il ne doit jamais valoir jeton de session
const STATE_SECRET = `${JWT_SECRET}:oauth-state`;

/* ============================================================
   Authentification (1.6).

   - « Rester connecté » : jeton de 30 jours, sinon 1 jour (et le site le
     garde seulement le temps de la session du navigateur).
   - Cloudflare Turnstile, si TURNSTILE_SECRET_KEY est renseignée.
   - Connexion avec Discord et Google, si leurs identifiants sont renseignés.
   - Mot de passe oublié, si l'envoi d'e-mails est configuré (SMTP_URL).
   Tant qu'une clé manque, la fonction correspondante reste simplement
   invisible sur l'écran de connexion (voir GET /auth/providers).
   ============================================================ */

const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();

function signSession(userId: string, remember: boolean) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: remember ? "30d" : "1d" });
}

async function findUserByEmail(email: string) {
  // les anciens comptes ont pu être créés avec des majuscules : recherche insensible à la casse
  return prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
}

const publicUser = (u: { id: string; email: string; pseudo: string }) => ({ id: u.id, email: u.email, pseudo: u.pseudo });

/* ---------- Cloudflare Turnstile ---------- */

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || "";
const TURNSTILE_SITE = process.env.TURNSTILE_SITE_KEY || "";

async function turnstileOk(req: Request) {
  if (!TURNSTILE_SECRET) return true;
  const token = typeof req.body?.turnstile === "string" ? req.body.turnstile : "";
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: req.ip ?? "" });
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const data = (await r.json()) as { success?: boolean };
    return !!data.success;
  } catch {
    // Cloudflare injoignable : on ne bloque pas toute la connexion pour autant
    console.error("[turnstile] vérification impossible");
    return true;
  }
}

/* ---------- OAuth ---------- */

type Provider = "discord" | "google";
const OAUTH = {
  discord: {
    id: process.env.DISCORD_CLIENT_ID || "",
    secret: process.env.DISCORD_CLIENT_SECRET || "",
    authorize: "https://discord.com/oauth2/authorize",
    token: "https://discord.com/api/oauth2/token",
    scope: "identify email",
  },
  google: {
    id: process.env.GOOGLE_CLIENT_ID || "",
    secret: process.env.GOOGLE_CLIENT_SECRET || "",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
  },
} as const;

const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || "").replace(/\/$/, "");
const SITE_URL = (process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");

function providerEnabled(p: Provider) {
  return !!(OAUTH[p].id && OAUTH[p].secret && API_PUBLIC_URL && SITE_URL);
}
const redirectUri = (p: Provider) => `${API_PUBLIC_URL}/api/auth/oauth/${p}/callback`;

export function providers(_req: Request, res: Response) {
  return res.json({
    discord: providerEnabled("discord"),
    google: providerEnabled("google"),
    turnstileSiteKey: TURNSTILE_SECRET && TURNSTILE_SITE ? TURNSTILE_SITE : null,
    passwordReset: mailEnabled(),
  });
}

export function oauthStart(req: Request, res: Response) {
  const p = req.params.provider as Provider;
  if (!(p in OAUTH) || !providerEnabled(p)) return res.status(404).send("Connexion indisponible");
  const state = jwt.sign({ p, r: req.query.remember === "1" ? 1 : 0, n: crypto.randomBytes(8).toString("hex") }, STATE_SECRET, { expiresIn: "10m" });
  const q = new URLSearchParams({
    client_id: OAUTH[p].id,
    redirect_uri: redirectUri(p),
    response_type: "code",
    scope: OAUTH[p].scope,
    state,
    ...(p === "google" ? { prompt: "select_account" } : { prompt: "none" }),
  });
  return res.redirect(`${OAUTH[p].authorize}?${q}`);
}

function backToSite(res: Response, params: Record<string, string>) {
  return res.redirect(`${SITE_URL}/auth#${new URLSearchParams(params)}`);
}

async function profileFor(p: Provider, code: string): Promise<{ email: string; name: string } | null> {
  const body = new URLSearchParams({
    client_id: OAUTH[p].id,
    client_secret: OAUTH[p].secret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(p),
  });
  const t = await fetch(OAUTH[p].token, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  if (!t.ok) return null;
  const { access_token } = (await t.json()) as { access_token?: string };
  if (!access_token) return null;
  const auth = { headers: { Authorization: `Bearer ${access_token}` } };
  if (p === "discord") {
    const u = (await (await fetch("https://discord.com/api/users/@me", auth)).json()) as { email?: string; verified?: boolean; global_name?: string; username?: string };
    // e-mail vérifié obligatoire : c'est lui qui relie le compte Discord à un compte existant
    if (!u.email || !u.verified) return null;
    return { email: normEmail(u.email), name: u.global_name || u.username || "" };
  }
  const u = (await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", auth)).json()) as { email?: string; email_verified?: boolean; name?: string; given_name?: string };
  if (!u.email || !u.email_verified) return null;
  return { email: normEmail(u.email), name: u.given_name || u.name || "" };
}

export async function oauthCallback(req: Request, res: Response) {
  const p = req.params.provider as Provider;
  if (!(p in OAUTH) || !providerEnabled(p)) return res.status(404).send("Connexion indisponible");
  if (req.query.error) return backToSite(res, { erreur: "Connexion annulée" });
  let remember = false;
  try {
    const s = jwt.verify(String(req.query.state ?? ""), STATE_SECRET) as { p: string; r: number };
    if (s.p !== p) throw new Error("state");
    remember = s.r === 1;
  } catch {
    return backToSite(res, { erreur: "La connexion a expiré, réessayez" });
  }
  try {
    const profile = await profileFor(p, String(req.query.code ?? ""));
    if (!profile) return backToSite(res, { erreur: `${p === "discord" ? "Discord" : "Google"} n'a pas fourni d'adresse e-mail vérifiée` });
    let user = await findUserByEmail(profile.email);
    let created = false;
    if (!user) {
      const pseudo = (profile.name || profile.email.split("@")[0]).trim().slice(0, 24) || "Cheminot";
      // mot de passe aléatoire : le compte pourra en choisir un via « Mot de passe oublié »
      const password = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);
      user = await prisma.user.create({ data: { email: profile.email, pseudo, password } });
      created = true;
    }
    return backToSite(res, { token: signSession(user.id, remember), remember: remember ? "1" : "0", ...(created ? { nouveau: "1" } : {}) });
  } catch (e) {
    console.error("[oauth]", (e as Error).message);
    return backToSite(res, { erreur: "Connexion impossible pour le moment" });
  }
}

/* ---------- inscription, connexion ---------- */

export async function register(req: Request, res: Response) {
  const email = normEmail(req.body?.email);
  const pseudo = String(req.body?.pseudo ?? "").trim();
  const password = String(req.body?.password ?? "");
  const remember = req.body?.remember !== false;

  if (!email || !pseudo || !password) {
    return res.status(400).json({ error: "Email, pseudo et mot de passe sont requis" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Adresse e-mail invalide" });
  if (password.length < 8) return res.status(400).json({ error: "Le mot de passe doit faire au moins 8 caractères" });
  if (pseudo.length > 24) return res.status(400).json({ error: "Le pseudo fait 24 caractères au plus" });
  if (!(await turnstileOk(req))) return res.status(400).json({ error: "Vérification anti-robot échouée, réessayez" });

  if (await findUserByEmail(email)) {
    return res.status(409).json({ error: "Un compte existe déjà avec cet email" });
  }

  const user = await prisma.user.create({ data: { email, pseudo, password: await bcrypt.hash(password, 10) } });
  return res.status(201).json({ token: signSession(user.id, remember), user: publicUser(user) });
}

export async function login(req: Request, res: Response) {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password ?? "");
  const remember = req.body?.remember !== false;

  if (!email || !password) {
    return res.status(400).json({ error: "Email et mot de passe sont requis" });
  }
  if (!(await turnstileOk(req))) return res.status(400).json({ error: "Vérification anti-robot échouée, réessayez" });

  const user = await findUserByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: "Email ou mot de passe incorrect" });
  }
  return res.json({ token: signSession(user.id, remember), user: publicUser(user) });
}

/* ---------- mot de passe oublié ---------- */

const RESET_TTL_MS = 60 * 60_000;
const forgotHits = new Map<string, number[]>();

function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const hits = (forgotHits.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.push(now);
  forgotHits.set(key, hits);
  return hits.length > max;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export async function forgotPassword(req: Request, res: Response) {
  if (!mailEnabled()) return res.status(503).json({ error: "La réinitialisation par e-mail n'est pas disponible" });
  const email = normEmail(req.body?.email);
  if (limited(`ip:${req.ip}`, 5, 15 * 60_000) || limited(`mail:${email}`, 3, 60 * 60_000)) {
    return res.status(429).json({ error: "Trop de demandes, réessayez dans quelques minutes" });
  }
  if (!(await turnstileOk(req))) return res.status(400).json({ error: "Vérification anti-robot échouée, réessayez" });

  // même réponse que le compte existe ou non : on ne révèle pas qui est inscrit
  const done = () => res.json({ ok: true });
  const user = await findUserByEmail(email);
  if (!user) return done();

  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.passwordReset.create({ data: { userId: user.id, tokenHash: sha(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) } });
  const link = `${SITE_URL}/auth?reset=${token}`;
  await sendMail(user.email, "Réseau : choisir un nouveau mot de passe", [
    `Bonjour ${user.pseudo},`,
    "",
    "Quelqu'un (vous, espérons-le) a demandé à changer le mot de passe de votre compte Réseau.",
    `Pour en choisir un nouveau, ouvrez ce lien dans l'heure : ${link}`,
    "",
    "Si vous n'avez rien demandé, ignorez ce message : votre mot de passe reste le même.",
  ].join("\n")).catch((e) => console.error("[mail]", (e as Error).message));
  return done();
}

export async function resetPassword(req: Request, res: Response) {
  const token = String(req.body?.token ?? "");
  const password = String(req.body?.password ?? "");
  if (password.length < 8) return res.status(400).json({ error: "Le mot de passe doit faire au moins 8 caractères" });
  const row = await prisma.passwordReset.findUnique({ where: { tokenHash: sha(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) {
    return res.status(400).json({ error: "Ce lien a expiré ou a déjà servi. Refaites une demande." });
  }
  // usage unique, même si deux onglets envoient le formulaire en même temps
  const claimed = await prisma.passwordReset.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count === 0) return res.status(400).json({ error: "Ce lien a déjà servi" });
  const user = await prisma.user.update({ where: { id: row.userId }, data: { password: await bcrypt.hash(password, 10) } });
  return res.json({ token: signSession(user.id, true), user: publicUser(user) });
}
