import { prisma } from "../prisma";
import { economy, inTrial } from "./settings.service";
import { buildLeaderRows } from "./leaderboard.service";
import { parisDate, startOfParisWeek } from "./time.service";

/* ============================================================
   2.4 : la taxe carbone, progressive.

   Chaque compagnie a un quota gratuit par semaine. Au-delà, chaque tonne
   se paie, à un prix qui dépend de la taille de la compagnie : la valeur
   est découpée en tranches, comme l'impôt sur le revenu, et chaque tranche
   a son prix de la tonne. Le prix appliqué est la moyenne de ces prix,
   pondérée par la part de la valeur dans chaque tranche : il monte en
   douceur avec la taille, sans effet de seuil.

   Une compagnie de moins de 100 000 pi. ne paie jamais rien. Une compagnie
   à 20 M paie autour de 125 pi. la tonne, à 50 M autour de 230.

   Prélevée chaque lundi à minuit (heure de Paris), sur la semaine écoulée.
   ============================================================ */

/* Prix moyen de la tonne pour une compagnie de cette valeur. */
export function carbonRate(valuation: number, brackets = economy().carbonBrackets) {
  const v = Math.max(0, valuation);
  if (v <= 0) return 0;
  const sorted = [...brackets].sort((a, b) => a.from - b.from);
  let weighted = 0;
  for (let i = 0; i < sorted.length; i++) {
    const lo = sorted[i].from;
    const hi = i + 1 < sorted.length ? sorted[i + 1].from : Infinity;
    if (v <= lo) break;
    weighted += (Math.min(v, hi) - lo) * sorted[i].rate;
  }
  return weighted / v;
}

/* La tranche la plus haute atteinte, pour l'affichage. */
export function carbonBracket(valuation: number, brackets = economy().carbonBrackets) {
  const sorted = [...brackets].sort((a, b) => a.from - b.from);
  let idx = 0;
  sorted.forEach((b, i) => {
    if (valuation >= b.from) idx = i;
  });
  return { index: idx, from: sorted[idx].from, to: sorted[idx + 1]?.from ?? null, rate: sorted[idx].rate };
}

export function carbonTax(emitted: number, valuation: number) {
  const s = economy();
  const taxable = Math.max(0, emitted - s.weeklyQuota);
  const rate = carbonRate(valuation);
  return { quota: s.weeklyQuota, taxable, rate, amount: Math.round(taxable * rate) };
}

function weekKey(monday: Date) {
  const d = parisDate(monday);
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/* Le lundi : la facture de la semaine écoulée, et le compteur repart à zéro.
   Rien n'est fait deux fois : la facture a une clé (compagnie, semaine). */
export async function runCarbonWeek(now = new Date()) {
  const monday = startOfParisWeek(now);
  const lastWeek = weekKey(new Date(monday.getTime() - 3 * 86_400_000));
  const marker = await prisma.gameSetting.findUnique({ where: { key: "carbonWeek" } }).catch(() => null);
  const done = (marker?.value as { week?: string } | null)?.week;
  if (done === lastWeek) return null;
  // premier passage après la mise en ligne : on pose le repère sans facturer une semaine incomplète
  if (!done) {
    await prisma.gameSetting.upsert({ where: { key: "carbonWeek" }, create: { key: "carbonWeek", value: { week: lastWeek } }, update: { value: { week: lastWeek } } });
    await prisma.company.updateMany({ data: { co2Week: 0 } });
    return null;
  }
  const trial = inTrial(now.getTime());
  const rows = await buildLeaderRows();
  const value = new Map(rows.map((r) => [r.id, Math.round(r.valeur)]));
  const companies = (await prisma.company.findMany({ where: { co2Week: { gt: 0 } }, select: { id: true, balance: true, co2Week: true } })) as { id: string; balance: number; co2Week: number }[];
  let billed = 0;
  let total = 0;
  for (const c of companies) {
    const valuation = value.get(c.id) ?? c.balance;
    const t = carbonTax(c.co2Week, valuation);
    const exists = await prisma.carbonBill.findUnique({ where: { companyId_week: { companyId: c.id, week: lastWeek } } });
    if (exists) continue;
    const amount = trial ? t.amount : Math.min(t.amount, Math.max(0, c.balance));
    const ops: unknown[] = [
      prisma.carbonBill.create({
        data: { companyId: c.id, week: lastWeek, emitted: c.co2Week, quota: t.quota, taxable: t.taxable, valuation, rate: t.rate, amount: t.amount, trial },
      }),
    ];
    if (!trial && amount > 0) {
      ops.push(
        prisma.company.update({ where: { id: c.id }, data: { balance: { decrement: amount } } }),
        prisma.transaction.create({
          data: { companyId: c.id, type: "CARBONE", amount: -amount, description: `Taxe carbone, semaine du ${lastWeek.split("-").reverse().join("/")} : ${Math.round(t.taxable)} t au-delà du quota, ${t.rate.toFixed(0)} pi. la tonne` },
        })
      );
      billed++;
      total += amount;
    }
    await prisma.$transaction(ops as never).catch((err: Error) => console.error("[carbone] facture :", err.message));
  }
  await prisma.company.updateMany({ data: { co2Week: 0 } });
  await prisma.gameSetting.upsert({ where: { key: "carbonWeek" }, create: { key: "carbonWeek", value: { week: lastWeek } }, update: { value: { week: lastWeek } } });
  return { week: lastWeek, billed, total, trial };
}
