import { prisma } from "../prisma";
import { logStaff } from "./discord-modlog.service";
import { esc } from "./discord.service";

/* ============================================================
   Panneau d'administration (2.2).

   Qui est admin : les adresses e-mail listées dans ADMIN_EMAILS (séparées
   par des virgules). Rien en base : un compte ne peut pas se donner les
   droits lui-même, et retirer quelqu'un se fait en changeant la variable
   dans Coolify. Sans ADMIN_EMAILS, le panneau est fermé à tout le monde.

   Les comptes suspendus sont gardés en mémoire (rafraîchis chaque minute)
   pour que requireAuth puisse les refuser sans une requête de plus à
   chaque appel de l'API.
   ============================================================ */

const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

export function isAdminEmail(email: string | null | undefined) {
  return Boolean(email && ADMIN_EMAILS.has(email.trim().toLowerCase()));
}

export function adminConfigured() {
  return ADMIN_EMAILS.size > 0;
}

/* ---------------- comptes suspendus ---------------- */

const REFRESH_MS = 60_000;
// motif, date et fin éventuelle gardés avec l'identifiant : l'écran
// « compte suspendu » les affiche
type Ban = { reason: string | null; since: Date; until: Date | null };
let banned = new Map<string, Ban>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

/* Suspensions temporaires arrivées à leur fin : levées en base et rôles
   Discord rendus. Fait au rafraîchissement de la liste, une fois par minute. */
async function liftExpired() {
  const rows = (await prisma.user.findMany({
    where: { bannedAt: { not: null }, bannedUntil: { lte: new Date() } },
    select: { id: true, company: { select: { id: true, name: true } } },
  })) as { id: string; company: { id: string; name: string } | null }[];
  if (!rows.length) return;
  await prisma.user.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { bannedAt: null, bannedReason: null, bannedUntil: null } });
  const { syncCompany } = await import("./discord-roles.service");
  for (const r of rows) {
    banned.delete(r.id);
    if (r.company) void syncCompany(r.company.id).catch(() => undefined);
    void logStaff(`🛠️ Fin de suspension${r.company ? ` · ${esc(r.company.name)}` : ""} (levée automatiquement)`);
  }
}

async function reload() {
  try {
    await liftExpired().catch((err: Error) => console.error("[admin] fin des suspensions :", err.message));
    const rows = (await prisma.user.findMany({
      where: { bannedAt: { not: null } },
      select: { id: true, bannedAt: true, bannedReason: true, bannedUntil: true },
    })) as { id: string; bannedAt: Date; bannedReason: string | null; bannedUntil: Date | null }[];
    banned = new Map(rows.map((r) => [r.id, { reason: r.bannedReason, since: r.bannedAt, until: r.bannedUntil }]));
    loadedAt = Date.now();
  } catch (err) {
    // base injoignable : on garde la liste connue, on réessaiera
    console.error("[admin] liste des comptes suspendus :", (err as Error).message);
    loadedAt = Date.now() - REFRESH_MS + 10_000;
  } finally {
    loading = null;
  }
}

/* Vrai si le compte est suspendu. Ne bloque jamais : la liste se rafraîchit
   en arrière-plan, et une suspension faite ici est prise en compte aussitôt.
   Une suspension temporaire finie ne bloque plus, même avant d'être levée en base. */
export function isBanned(userId: string) {
  if (Date.now() - loadedAt > REFRESH_MS && !loading) loading = reload();
  const b = banned.get(userId);
  if (!b) return false;
  return !b.until || b.until.getTime() > Date.now();
}

export function markBanned(userId: string, on: boolean, reason?: string, until?: Date | null) {
  if (on) banned.set(userId, { reason: reason ?? null, since: new Date(), until: until ?? null });
  else banned.delete(userId);
}

/* Réponse 403 d'un compte suspendu : le site s'en sert pour afficher le motif. */
export function bannedBody(userId: string) {
  const b = banned.get(userId);
  return {
    error: "Ce compte est suspendu. Contactez l'équipe de Réseau sur Discord.",
    banned: true,
    reason: b?.reason ?? null,
    since: b?.since?.toISOString() ?? null,
    until: b?.until?.toISOString() ?? null,
  };
}

export function warmBanList() {
  if (!loading) loading = reload();
  return loading;
}

/* ---------------- journal ---------------- */

export type AdminActor = { id: string; name: string };

export async function logAdmin(
  actor: AdminActor,
  action: string,
  target: { id?: string | null; label?: string | null } | null,
  details: string
) {
  await prisma.adminAction
    .create({
      data: { adminId: actor.id, adminName: actor.name, action, targetId: target?.id ?? null, target: target?.label ?? null, details },
    })
    .catch((err: Error) => console.error("[admin] journal :", err.message));
  // la même ligne dans #logs, pour que le reste du staff voie passer les actions
  void logStaff(`🛠️ **${actor.name}** (panneau admin) · ${action}${target?.label ? ` · ${esc(target.label)}` : ""}${details ? ` — ${esc(details)}` : ""}`);
}
