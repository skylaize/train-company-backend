import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";

/* ============================================================
   2.4 : outils pour que la simulation parle moins à la base.

   Le tour faisait des milliers d'allers-retours séquentiels vers Postgres :
   une requête par rame qui avance, une transaction par compagnie pour
   l'entretien, deux requêtes par employé pour la paie… Avec une base sur
   une autre machine, chaque aller-retour coûte quelques millisecondes, et
   des milliers de quelques millisecondes font un tour de 100 secondes.

   Deux remèdes :
   - regrouper : une seule requête SQL pour N lignes (UPDATE … FROM VALUES) ;
   - paralléliser : quand les écritures ne se marchent pas dessus (une
     compagnie par file), plusieurs files avancent en même temps.
   ============================================================ */

/* Nombre de files parallèles de la simulation. Il faut en laisser au pool de
   connexions pour les requêtes des joueurs (voir prisma.ts). */
export const SIM_CONCURRENCY = Math.max(1, Number(process.env.SIM_CONCURRENCY) || 6);

/* Exécute fn sur chaque élément, au plus `limit` à la fois. Une erreur sur un
   élément est journalisée et n'arrête pas les autres. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, label = "lot") {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        console.error(`[simulation] ${label} :`, (err as Error).message);
      }
    }
  });
  await Promise.all(workers);
}

export function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = out.get(k);
    if (list) list.push(it);
    else out.set(k, [it]);
  }
  return out;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* Une ligne de VALUES : (a, b, c). */
export function row(values: unknown[]) {
  return Prisma.sql`(${Prisma.join(values)})`;
}

/* Ajoute (ou retire, si négatif) un montant à la trésorerie de plusieurs
   compagnies en une requête. */
export async function incrementBalances(deltas: Map<string, number>) {
  const entries = [...deltas.entries()].filter(([, d]) => d !== 0);
  for (const part of chunk(entries, 500)) {
    await prisma.$executeRaw`
      UPDATE "Company" AS c SET "balance" = c."balance" + v.delta::int
      FROM (VALUES ${Prisma.join(part.map(([id, d]) => row([id, Math.round(d)])))}) AS v(id, delta)
      WHERE c."id" = v.id::text`;
  }
}

/* Petit chronomètre par étape : quand un tour est lent, le journal dit enfin
   lesquelles ont pris le temps. */
export class TickTimer {
  private steps: { name: string; ms: number }[] = [];
  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      this.steps.push({ name, ms: Date.now() - t });
    }
  }
  report(top = 8) {
    return [...this.steps]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, top)
      .filter((s) => s.ms >= 50)
      .map((s) => `${s.name} ${(s.ms / 1000).toFixed(1)} s`)
      .join(" · ");
  }
}
