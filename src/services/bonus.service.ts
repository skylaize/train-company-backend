import { prisma } from "../prisma";
import { routeOf } from "./route.service";
import { controllerBonus, driverEffects } from "./crew.service";
import { effectsFor } from "./staff.service";
import { computeReputation } from "./reputation.service";
import { heritageOf, heritagePrestige, HERITAGE_WEAR } from "./wreck.service";
import { HERITAGE_SEATS, CAR_SLOWDOWN } from "./ridership.service";
import { ELECTRIC_SPEED, ELECTRIC_WEAR, DOUBLE_SPEED, WORKSHOP_WEAR, HOME_BONUS_STEP, HOME_BONUS_CAP } from "./infrastructure.service";
import { DLC_MODELS, MOUNTAIN_STATIONS, MOUNTAIN_WEAR, CORSICA_STATIONS, CORSICA_WEAR, CORSICA_RAILCAR } from "./dlc.service";
import { TGV_MODEL, TGV_FARE, TGV_CLASSIC_FARE, TGV_SPEED, TGV_CLASSIC_SPEED, TGV_WEAR, hslOpen } from "./highspeed.service";
import { INTL_REVENUE_BONUS, isInternational } from "./international.service";
import { NIGHT_MULTIPLIER, DAY_COUCHETTES_MULTIPLIER } from "./time.service";
import { NIGHT_INTL_FARE, isNightIntl } from "./night.service";

/* ============================================================
   2.6 : ce qui joue sur une rame.

   Les bonus et malus d'une rame étaient éparpillés (personnel, ligne, gares,
   matériel) : la fiche de la rame les réunit. Mêmes règles que la
   simulation, lues une fois à l'ouverture de la fiche, sans rien recalculer
   de la demande. Les effets du moment (événements, météo, concurrence) ne
   sont pas listés : ils changent d'un trajet à l'autre.
   ============================================================ */

export type Bonus = { kind: "recette" | "vitesse" | "usure" | "places"; label: string; effect: string; good: boolean };

const pct = (m: number) => `${m >= 1 ? "+" : "−"}${Math.round(Math.abs(m - 1) * 100)} %`;

export async function trainBonuses(trainId: string, companyId: string): Promise<Bonus[] | null> {
  const train = (await prisma.train.findFirst({
    where: { id: trainId, companyId },
    select: { model: true, cars: true, heritage: true, line: { select: { departureStation: true, arrivalStation: true, stops: true, electrified: true, doubleTrack: true, highSpeedAt: true } } },
  })) as {
    model: string; cars: string[]; heritage: unknown;
    line: { departureStation: string; arrivalStation: string; stops: string[]; electrified: boolean; doubleTrack: boolean; highSpeedAt: Date | null } | null;
  } | null;
  if (!train) return null;

  const [crew, staff, trainCount, workshops, owned, reputation] = (await Promise.all([
    prisma.staff.findMany({ where: { trainId }, select: { role: true, level: true } }),
    prisma.staff.findMany({ where: { companyId, role: { in: ["MECANICIEN", "CHEF_DEPOT", "DIRECTEUR_COMMERCIAL"] } }, select: { companyId: true, role: true, level: true } }),
    prisma.train.count({ where: { companyId } }),
    prisma.workshop.findMany({ where: { companyId }, select: { station: true } }),
    prisma.stationOwnership.findMany({ where: { companyId }, select: { station: true } }),
    computeReputation(companyId).catch(() => null),
  ])) as [{ role: string; level: number }[], { companyId: string; role: string; level: number }[], number, { station: string }[], { station: string }[], number | null];

  const out: Bonus[] = [];
  const add = (kind: Bonus["kind"], label: string, mult: number, inverse = false) => {
    if (Math.abs(mult - 1) < 0.005) return;
    // une durée ou une usure qui baisse est une bonne nouvelle
    out.push({ kind, label, effect: pct(mult), good: inverse ? mult < 1 : mult > 1 });
  };

  // ---- l'équipage et le personnel
  const ctrl = crew.find((c) => c.role === "CONTROLEUR");
  const drv = crew.find((c) => c.role === "CONDUCTEUR");
  if (ctrl) add("recette", `Contrôleur à bord (niveau ${ctrl.level})`, controllerBonus(ctrl.level));
  if (drv) {
    add("usure", `Conducteur à bord (niveau ${drv.level})`, driverEffects(drv.level).wear, true);
    out.push({ kind: "vitesse", label: "Conducteur à bord", effect: "retards −40 %, incidents ÷2", good: true });
  }
  const fx = effectsFor(staff as never, trainCount);
  add("recette", "Directeur commercial", fx.revenueMultiplier);
  add("usure", "Mécaniciens", fx.wearMultiplier, true);
  if (reputation !== null) add("recette", `Réputation (${Math.round(reputation)} / 100)`, 0.5 + (reputation / 100) * 0.5);

  // ---- le matériel
  const dlc = DLC_MODELS[train.model];
  if (dlc) {
    add("recette", `${dlc.label} : billet`, dlc.fare);
    add("vitesse", `${dlc.label} : durée du trajet`, dlc.speed, true);
    add("usure", `${dlc.label} : usure`, dlc.wear, true);
  }
  if (train.model === "EXPRESS") add("vitesse", "Rame Express", 0.7, true);
  const h = heritageOf(train);
  if (h) {
    add("recette", `${h.label} : rame de collection`, heritagePrestige(h));
    add("places", `${h.label} : deux niveaux`, HERITAGE_SEATS[h.kind] ?? 1);
    add("usure", "Matériel ancien", HERITAGE_WEAR, true);
  }
  if (train.cars?.length) add("vitesse", `${train.cars.length} voiture${train.cars.length > 1 ? "s" : ""} ou wagon${train.cars.length > 1 ? "s" : ""} en plus`, 1 + CAR_SLOWDOWN * train.cars.length, true);

  // ---- la ligne
  const l = train.line;
  if (l) {
    const route = routeOf(l);
    if (l.electrified) {
      add("vitesse", "Ligne électrifiée", ELECTRIC_SPEED, true);
      add("usure", "Ligne électrifiée", ELECTRIC_WEAR, true);
    }
    if (l.doubleTrack) add("vitesse", "Double voie", DOUBLE_SPEED, true);
    const tgv = train.model === TGV_MODEL && hslOpen(l);
    if (train.model === TGV_MODEL) {
      add("recette", tgv ? "TGV sur sa LGV" : "TGV sur ligne classique", tgv ? TGV_FARE : TGV_CLASSIC_FARE);
      add("vitesse", tgv ? "TGV sur sa LGV" : "TGV sur ligne classique", tgv ? TGV_SPEED : TGV_CLASSIC_SPEED, true);
      add("usure", "Grande vitesse", TGV_WEAR, true);
    }
    if (route.some(isInternational)) out.push({ kind: "recette", label: "Ligne internationale", effect: `${pct(INTL_REVENUE_BONUS)}, péage déduit`, good: true });
    if (train.model === "COUCHETTES") out.push({ kind: "recette", label: "Rame couchettes", effect: `×${NIGHT_MULTIPLIER} la nuit, ${pct(DAY_COUCHETTES_MULTIPLIER)} le jour`, good: true });
    if (isNightIntl(train.model)) out.push({ kind: "recette", label: "Train de nuit international", effect: `×${NIGHT_MULTIPLIER} la nuit, voitures-lits ${pct(NIGHT_INTL_FARE)}`, good: true });
    const ownedSet = new Set(owned.map((o) => o.station));
    const home = new Set(route.filter((st) => ownedSet.has(st))).size;
    if (home) add("recette", `${home} de vos gares sur le trajet`, 1 + Math.min(HOME_BONUS_CAP, HOME_BONUS_STEP * home));
    if (workshops.some((w) => route.includes(w.station))) add("usure", "Atelier régional sur le trajet", WORKSHOP_WEAR, true);
    if (route.some((st) => MOUNTAIN_STATIONS.includes(st)) && train.model !== "CREMAILLERE") add("usure", "Montagne sans crémaillère", MOUNTAIN_WEAR, true);
    if (route.some((st) => CORSICA_STATIONS.includes(st)) && train.model !== CORSICA_RAILCAR) add("usure", "Voie métrique corse", CORSICA_WEAR, true);
  }
  return out;
}
