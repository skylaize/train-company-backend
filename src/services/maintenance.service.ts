import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma";
import { isAdminEmail } from "./admin.service";

/* ============================================================
   Maintenance, pilotée depuis le panneau d'administration.

   Deux temps :
   - annoncée : startsAt dans le futur. Toutes les réponses de l'API portent
     l'en-tête X-Maintenance ; le site en tire un bandeau « maintenance à
     20 h ». Aucune requête en plus côté joueurs.
   - en cours : à partir de startsAt (ou tout de suite). L'API répond 503 à
     tout le monde sauf aux admins ; le site affiche l'écran de maintenance
     et revient tout seul quand elle est finie.

   Les trains continuent de rouler : seules les actions des joueurs sont
   bloquées. L'état est gardé dans GameSetting et relu toutes les 30 s.
   ============================================================ */

export type Maintenance = { message: string; startsAt: string; endsAt: string | null };

const KEY = "maintenance";
const REFRESH_MS = 30_000;
const JWT_SECRET = process.env.JWT_SECRET as string;

let current: Maintenance | null = null;
let loadedAt = 0;
let loading: Promise<void> | null = null;
// identifiants des comptes admins, pour les laisser passer pendant la maintenance
let adminIds: Set<string> | null = null;

function parse(v: unknown): Maintenance | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Partial<Maintenance>;
  if (!m.startsAt || Number.isNaN(Date.parse(m.startsAt))) return null;
  return { message: String(m.message ?? ""), startsAt: m.startsAt, endsAt: m.endsAt && !Number.isNaN(Date.parse(m.endsAt)) ? m.endsAt : null };
}

async function reload() {
  try {
    const row = await prisma.gameSetting.findUnique({ where: { key: KEY } });
    current = parse(row?.value);
    loadedAt = Date.now();
  } catch (err) {
    console.error("[maintenance] lecture :", (err as Error).message);
    loadedAt = Date.now() - REFRESH_MS + 10_000;
  } finally {
    loading = null;
  }
}

export function maintenance(): Maintenance | null {
  if (Date.now() - loadedAt > REFRESH_MS && !loading) loading = reload();
  /* 2.7.1 : une maintenance dont l'heure de fin est passée se termine toute
     seule. Avant, elle restait en place tant qu'on ne la levait pas dans
     l'admin : le bandeau (ou l'écran) ne partait jamais. */
  if (current?.endsAt && Date.parse(current.endsAt) <= Date.now()) {
    current = null;
    void prisma.gameSetting.deleteMany({ where: { key: KEY } }).catch(() => undefined);
  }
  return current;
}

export function maintenanceActive(m = maintenance()) {
  return Boolean(m && Date.parse(m.startsAt) <= Date.now());
}

export async function setMaintenance(m: Maintenance | null) {
  if (m) await prisma.gameSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: m as object }, update: { value: m as object } });
  else await prisma.gameSetting.deleteMany({ where: { key: KEY } });
  current = m;
  loadedAt = Date.now();
  adminIds = null;
}

async function loadAdminIds() {
  // une requête par maintenance : les comptes dont l'adresse est dans ADMIN_EMAILS
  const all = (await prisma.user.findMany({ where: { OR: adminEmailFilter() }, select: { id: true, email: true } })) as { id: string; email: string }[];
  adminIds = new Set(all.filter((u) => isAdminEmail(u.email)).map((u) => u.id));
}

function adminEmailFilter() {
  return String(process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => ({ email: { equals: e, mode: "insensitive" as const } }));
}

function userIdOf(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  try {
    return (jwt.verify(h.slice(7), JWT_SECRET) as { userId: string }).userId;
  } catch {
    return null;
  }
}

// ce qui reste ouvert pendant la maintenance : le panneau admin, la connexion
// (pour que les admins entrent) et l'état de la maintenance lui-même
const OPEN = /^\/api\/(admin|auth|status)(\/|$)/;

export async function maintenanceGate(req: Request, res: Response, next: NextFunction) {
  const m = maintenance();
  if (!m) return next();
  if (!maintenanceActive(m)) {
    res.setHeader("X-Maintenance", encodeURIComponent(JSON.stringify(m)));
    return next();
  }
  if (req.method === "OPTIONS" || !req.path.startsWith("/api/") || OPEN.test(req.path)) return next();
  const uid = userIdOf(req);
  if (uid) {
    if (!adminIds) await loadAdminIds().catch(() => undefined);
    if (adminIds?.has(uid)) return next();
  }
  return res.status(503).json({ error: "Réseau est en maintenance. Revenez dans quelques minutes.", maintenance: true, message: m.message, endsAt: m.endsAt });
}
