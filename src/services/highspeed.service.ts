import { prisma } from "../prisma";
import { routeKmOf } from "./infrastructure.service";

/* ============================================================
   2.2 : les lignes à grande vitesse.

   Le dernier étage de l'infrastructure, après l'électrification et la
   double voie, et il les demande toutes les deux. Une LGV se pose sur une
   ligne existante d'au moins 200 km et se construit en vrai temps : un jour
   pour 75 km, de 3 à 10 jours. Pendant le chantier, la ligne roule comme
   avant ; ses gares, elles, sont figées dès le premier coup de pioche (on
   ne déplace pas une LGV). Un seul chantier de LGV à la fois par compagnie.

   Sur une LGV ouverte roule la rame TGV, et elle seule en profite : trajets
   deux fois plus courts environ, billet un peu plus cher, 500 places. En
   contrepartie elle s'use plus vite et coûte cher. Une rame classique peut
   toujours rouler sur la ligne, à sa vitesse habituelle.

   Comme ailleurs dans le jeu, le Premium n'accélère pas les chantiers.
   ============================================================ */

export const HSL_PER_KM = 60;
export const HSL_MIN_COST = 12_000;
export const HSL_MIN_KM = 200;
export const HSL_KM_PER_DAY = 75;
export const HSL_MIN_DAYS = 3;
export const HSL_MAX_DAYS = 10;
export const HSL_MIN_GRADE = 3; // Baron du rail
export const HSL_WORTH = 0.5; // une LGV compte pour moitié de son prix dans la valeur de la compagnie

export const TGV_MODEL = "TGV";
export const TGV_COST = 6_000;
export const TGV_MIN_GRADE = 3;
export const TGV_SEATS = 500;
export const TGV_SPEED = 0.55; // durée × 0,55
export const TGV_FARE = 1.15;
export const TGV_WEAR = 1.25;

const DAY_MS = 86_400_000;

export function hslCost(route: string[]) {
  return Math.max(HSL_MIN_COST, Math.round((routeKmOf(route) * HSL_PER_KM) / 100) * 100);
}

export function hslDays(route: string[]) {
  return Math.min(HSL_MAX_DAYS, Math.max(HSL_MIN_DAYS, Math.round(routeKmOf(route) / HSL_KM_PER_DAY)));
}

export type HslLine = { highSpeedAt?: Date | string | null };

/* La LGV est ouverte (et non plus en chantier). */
export function hslOpen(l: HslLine | null | undefined, now = Date.now()) {
  return Boolean(l?.highSpeedAt && new Date(l.highSpeedAt).getTime() <= now);
}

export function hslBuilding(l: HslLine | null | undefined, now = Date.now()) {
  return Boolean(l?.highSpeedAt && new Date(l.highSpeedAt).getTime() > now);
}

/* Pourquoi cette ligne ne peut pas recevoir de LGV, ou null si elle le peut. */
export function hslLineError(l: { electrified: boolean; doubleTrack: boolean; highSpeedAt?: Date | null }, route: string[]) {
  if (l.highSpeedAt) return hslOpen(l) ? "Cette ligne est déjà à grande vitesse" : "Le chantier de la LGV est déjà en cours";
  if (routeKmOf(route) < HSL_MIN_KM) return `Une LGV demande une ligne d'au moins ${HSL_MIN_KM} km (celle-ci en fait ${routeKmOf(route)})`;
  if (!l.electrified && !l.doubleTrack) return "Électrifiez la ligne et posez la double voie d'abord";
  if (!l.electrified) return "Électrifiez la ligne d'abord";
  if (!l.doubleTrack) return "Posez la double voie d'abord";
  return null;
}

export function hslReadyAt(route: string[], from = Date.now()) {
  return new Date(from + hslDays(route) * DAY_MS);
}

/* Les LGV qui viennent d'ouvrir et n'ont pas encore été annoncées au joueur. */
export async function runHighSpeedOpenings(notify: (companyId: string, title: string, body: string) => Promise<void>) {
  const opened = (await prisma.line.findMany({
    where: { highSpeedAt: { lte: new Date() }, highSpeedNotified: false },
    select: { id: true, companyId: true, departureStation: true, arrivalStation: true, stops: true },
  })) as { id: string; companyId: string; departureStation: string; arrivalStation: string; stops: string[] }[];
  for (const l of opened) {
    const claimed = await prisma.line.updateMany({ where: { id: l.id, highSpeedNotified: false }, data: { highSpeedNotified: true } });
    if (!claimed.count) continue;
    const route = [l.departureStation, ...(l.stops ?? []), l.arrivalStation];
    await prisma.transaction.create({
      data: { companyId: l.companyId, type: "LGV", amount: 0, lineId: l.id, description: `LGV ouverte : ${route.join(" – ")} (${routeKmOf(route)} km)` },
    });
    await notify(l.companyId, "Votre LGV est ouverte", `${route[0]} – ${route[route.length - 1]} : les rames TGV peuvent y rouler à pleine vitesse.`).catch(() => undefined);
  }
  return opened.length;
}

/* km de LGV ouvertes, par compagnie (classement « Grande vitesse »). */
export async function hslKmByCompany() {
  const rows = (await prisma.line.findMany({
    where: { highSpeedAt: { lte: new Date() } },
    select: { companyId: true, departureStation: true, arrivalStation: true, stops: true },
  })) as { companyId: string; departureStation: string; arrivalStation: string; stops: string[] }[];
  const m = new Map<string, number>();
  for (const l of rows) m.set(l.companyId, (m.get(l.companyId) ?? 0) + routeKmOf([l.departureStation, ...(l.stops ?? []), l.arrivalStation]));
  return m;
}
