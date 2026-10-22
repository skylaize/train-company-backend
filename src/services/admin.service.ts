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
let banned = new Set<string>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

async function reload() {
  try {
    const rows = (await prisma.user.findMany({ where: { bannedAt: { not: null } }, select: { id: true } })) as { id: string }[];
    banned = new Set(rows.map((r) => r.id));
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
   en arrière-plan, et une suspension faite ici est prise en compte aussitôt. */
export function isBanned(userId: string) {
  if (Date.now() - loadedAt > REFRESH_MS && !loading) loading = reload();
  return banned.has(userId);
}

export function markBanned(userId: string, on: boolean) {
  if (on) banned.add(userId);
  else banned.delete(userId);
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
