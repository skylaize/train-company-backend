import { prisma } from "../prisma";
import { resaleValue } from "./workshop.service";

/* ============================================================
   2.1.1 (Premium) : les alertes personnalisées.

   Le joueur choisit ce qui mérite qu'on le prévienne, avec son seuil :
   trésorerie qui passe sous un montant, rame usée au-delà d'un pourcentage,
   contrat de fret qui paie au moins tant, rame dont la reprise atteint un
   prix. Une alerte se déclenche quand la condition DEVIENT vraie (ou quand
   ce qui la déclenche change : une autre rame, un autre contrat), pas à
   chaque minute tant qu'elle l'est. Elle part en notification sur le
   téléphone et s'affiche dans le jeu.
   ============================================================ */

export const ALERT_KINDS = ["TRESORERIE", "USURE", "FRET", "REVENTE"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const MAX_ALERTS = 10;

export type AlertRow = { id: string; companyId: string; kind: string; threshold: number; targetId: string | null; active: boolean; lastKey: string | null };
type Notify = (companyId: string, title: string, body: string) => Promise<unknown>;

const fmt = (n: number) => Math.round(n).toLocaleString("fr-FR");

/* ce que vaut chaque alerte en ce moment : déclenchée ou non, et ce qui la déclenche */
type Check = { on: boolean; key?: string; title?: string; body?: string };

export async function runCustomAlerts(notify: Notify, modelCost: (model: string) => number) {
  const alerts = (await prisma.customAlert.findMany({ where: { company: { isPremium: true } } })) as AlertRow[];
  if (alerts.length === 0) return;
  const companyIds = [...new Set(alerts.map((a) => a.companyId))];
  const [companies, trains, market] = (await Promise.all([
    prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, balance: true } }),
    prisma.train.findMany({ where: { companyId: { in: companyIds } }, select: { id: true, companyId: true, name: true, model: true, wear: true, cars: true, purchasedAt: true, brokenPart: true, heritage: true } }),
    alerts.some((a) => a.kind === "FRET")
      ? prisma.contract.findMany({ where: { status: "DISPONIBLE", companyId: null }, select: { id: true, cargoType: true, reward: true, originStation: true, destinationStation: true }, orderBy: { reward: "desc" }, take: 30 })
      : Promise.resolve([]),
  ])) as [
    { id: string; balance: number }[],
    { id: string; companyId: string; name: string; model: string; wear: number; cars: string[]; purchasedAt: Date; brokenPart: string | null; heritage: unknown }[],
    { id: string; cargoType: string; reward: number; originStation: string; destinationStation: string }[]
  ];

  for (const a of alerts) {
    let c: Check = { on: false };
    if (a.kind === "TRESORERIE") {
      const bal = companies.find((x) => x.id === a.companyId)?.balance ?? 0;
      c = { on: bal < a.threshold, title: "Trésorerie basse", body: `Votre trésorerie est passée sous ${fmt(a.threshold)} pi. : ${fmt(bal)} pi.` };
    } else if (a.kind === "USURE") {
      const worn = trains.filter((t) => t.companyId === a.companyId && t.wear >= a.threshold).sort((x, y) => y.wear - x.wear);
      c = worn.length
        ? { on: true, key: worn.map((t) => t.id).sort().join(","), title: "Rames usées", body: `${worn.slice(0, 3).map((t) => `${t.name} (${t.wear} %)`).join(", ")}${worn.length > 3 ? ` et ${worn.length - 3} autre(s)` : ""} : usure de ${fmt(a.threshold)} % ou plus.` }
        : { on: false };
    } else if (a.kind === "FRET") {
      const best = market.find((k) => k.reward >= a.threshold);
      c = best
        ? { on: true, key: best.id, title: "Contrat de fret", body: `${best.cargoType}, ${best.originStation} → ${best.destinationStation} : ${fmt(best.reward)} pi. sur le marché.` }
        : { on: false };
    } else if (a.kind === "REVENTE") {
      const t = trains.find((x) => x.id === a.targetId && x.companyId === a.companyId);
      if (t && !t.heritage) {
        const v = resaleValue(t, modelCost(t.model));
        c = { on: v >= a.threshold, title: "Cote de revente", body: `${t.name} se reprend ${fmt(v)} pi. aujourd'hui (votre seuil : ${fmt(a.threshold)} pi.).` };
      }
    }
    const key = c.key ?? null;
    const fire = c.on && (!a.active || (key !== null && key !== a.lastKey));
    if (fire) {
      await prisma.customAlert.update({ where: { id: a.id }, data: { active: true, lastKey: key, firedAt: new Date(), message: `${c.title} : ${c.body}` } });
      await notify(a.companyId, c.title!, c.body!).catch(() => {});
    } else if (c.on !== a.active || (c.on && key !== a.lastKey)) {
      await prisma.customAlert.update({ where: { id: a.id }, data: { active: c.on, lastKey: c.on ? key : null } });
    }
  }
}
