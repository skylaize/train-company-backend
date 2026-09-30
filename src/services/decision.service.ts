import { prisma } from "../prisma";
import { parisHour } from "./time.service";
import { STATIONS } from "./geography.service";
import { stationSize } from "./station.service";
import { INTERNATIONAL_STATIONS } from "./international.service";
import { repairCostPerPoint, staffEffectsFor } from "./staff.service";
import { computeReputation } from "./reputation.service";

/* ============================================================
   Décisions du directeur (1.6).

   Les joueurs trouvaient le jeu « pas assez vivant » : une fois la ligne
   tracée et la rame affectée, tout tournait seul. De temps en temps,
   une situation arrive maintenant sur le bureau du directeur : une grève
   en gare, une fissure sur une rame, un maire qui veut sa ligne. Deux ou
   trois réponses, chacune avec un prix lisible, et une échéance. Sans
   réponse, la réponse par défaut (la moins bonne, en général) s'applique.

   Rythme : une décision ouverte à la fois, une nouvelle toutes les trois à
   cinq heures pour une compagnie active, jamais la nuit (pas de notification
   à 3 h du matin). Les montants suivent la taille de la compagnie.
   ============================================================ */

export type Tone = "gain" | "cout" | "risque" | "neutre";
export interface Choice {
  id: string;
  label: string;
  effects: { text: string; tone: Tone }[];
  locked?: string | null;
}

export const DECISION_TTL_MS = 2 * 3600_000; // deux heures pour répondre
const GAP_MIN_MS = 3 * 3600_000;
const GAP_MAX_MS = 5 * 3600_000;
const FIRST_DELAY_MS = 20 * 60_000; // la toute première arrive vite : c'est elle qui fait découvrir la mécanique
const QUIET_FROM = 23; // pas de nouvelle décision entre 23 h et 8 h (heure de Paris)
const QUIET_TO = 8;
const ACTIVE_WITHIN_MS = 3 * 86_400_000; // une compagnie abandonnée ne reçoit plus rien

/* Les montants suivent la taille : 100 pi. pèsent lourd à deux rames, rien à vingt. */
export function scaled(base: number, runningTrains: number) {
  const s = 1 + 0.35 * Math.max(0, Math.min(30, runningTrains) - 1);
  return Math.max(10, Math.round((base * s) / 10) * 10);
}

const fmt = (n: number) => n.toLocaleString("fr-FR").replace(/ | /g, " ");

interface Ctx {
  company: { id: string; balance: number; maxTrains: number };
  trains: { id: string; name: string; model: string; status: string; wear: number; lineId: string | null; line: { departureStation: string; arrivalStation: string } | null }[];
  lines: { id: string; departureStation: string; arrivalStation: string }[];
  reputation: number;
  rivalPairs: { a: string; b: string; rival: string }[];
  now: Date;
  pick: <T>(xs: T[]) => T;
}

export interface Draft {
  kind: string;
  title: string;
  body: string;
  place?: string | null;
  data?: Record<string, unknown>;
  choices: Choice[];
  defaultChoiceId: string;
}

/* ---------- le catalogue ---------- */

type Maker = (c: Ctx) => Draft | null;

const running = (c: Ctx) => c.trains.filter((t) => t.lineId && t.line);
const myStations = (c: Ctx) => [...new Set(c.lines.flatMap((l) => [l.departureStation, l.arrivalStation]))];

const MAKERS: Record<string, Maker> = {
  FISSURE: (c) => {
    const pool = running(c).filter((t) => t.wear < 90);
    if (pool.length === 0) return null;
    const t = c.pick(pool);
    return {
      kind: "FISSURE",
      title: `Une fissure sur la ${t.name}`,
      body: `À l'inspection, le mécanicien a trouvé une fissure sur un bogie de la ${t.name}. Rien d'urgent, dit-il, mais il préférerait la remettre en état tout de suite.`,
      place: t.line!.departureStation,
      data: { trainId: t.id },
      choices: [
        { id: "reparer", label: "La remettre à neuf maintenant", effects: [{ text: "Coût d'une réparation complète", tone: "cout" }, { text: "Usure remise à 0", tone: "gain" }] },
        { id: "rouler", label: "La laisser rouler", effects: [{ text: "Gratuit", tone: "gain" }, { text: "1 chance sur 3 de panne immédiate", tone: "risque" }] },
      ],
      defaultChoiceId: "rouler",
    };
  },

  FESTIVAL: (c) => {
    const stations = myStations(c);
    if (stations.length === 0) return null;
    const g = c.pick(stations);
    const n = running(c).length;
    const gain = scaled(150, n);
    const idle = c.trains.some((t) => !t.lineId && t.status === "IDLE" && t.model !== "COUCHETTES");
    return {
      kind: "FESTIVAL",
      title: `Festival à ${g} ce soir`,
      body: `Un festival de musique remplit ${g}. Les voyageurs se pressent sur les quais, et l'office du tourisme cherche une compagnie pour des trains supplémentaires.`,
      place: g,
      data: { station: g, gain },
      choices: [
        { id: "special", label: "Affréter un train spécial", effects: [{ text: `+${fmt(gain)} pi.`, tone: "gain" }, { text: "Il faut une rame libre au dépôt", tone: "neutre" }], locked: idle ? null : "Il faut une rame libre au dépôt" },
        { id: "tarif", label: `Augmenter les tarifs à ${g}`, effects: [{ text: "+30 % de recette pendant 2 h", tone: "gain" }, { text: "−3 réputation", tone: "risque" }] },
        { id: "rien", label: "Ne rien changer", effects: [{ text: "Rien ne bouge", tone: "neutre" }] },
      ],
      defaultChoiceId: "rien",
    };
  },

  GREVE: (c) => {
    const stations = myStations(c);
    if (stations.length === 0) return null;
    const g = c.pick(stations);
    const n = running(c).length;
    const prime = scaled(100, n);
    const interim = scaled(40, n);
    return {
      kind: "GREVE",
      title: `Préavis de grève à ${g}`,
      body: `Les aiguilleurs de ${g} réclament une prime pour les services de soirée. Sans accord, ils cessent le travail et vos trains y passeront au ralenti.`,
      place: g,
      data: { station: g, prime, interim },
      choices: [
        { id: "negocier", label: "Négocier une prime", effects: [{ text: `−${fmt(prime)} pi.`, tone: "cout" }, { text: "+2 réputation", tone: "gain" }] },
        { id: "interim", label: "Faire appel à des intérimaires", effects: [{ text: `−${fmt(interim)} pi.`, tone: "cout" }, { text: "1 chance sur 2 de −2 réputation", tone: "risque" }] },
        { id: "attendre", label: "Attendre que ça passe", effects: [{ text: `Recettes −50 % à ${g} pendant 2 h`, tone: "risque" }] },
      ],
      defaultChoiceId: "attendre",
    };
  },

  MAIRE: (c) => {
    const served = new Set(myStations(c));
    const candidates = STATIONS.filter((s) => !served.has(s) && !(s in INTERNATIONAL_STATIONS) && stationSize(s) >= 3);
    if (candidates.length === 0 || c.lines.length === 0) return null;
    const g = c.pick(candidates);
    const reward = scaled(250, running(c).length);
    return {
      kind: "MAIRE",
      title: `Le maire de ${g} vous écrit`,
      body: `« ${g} mérite mieux que ce qu'on lui offre aujourd'hui. Ouvrez une ligne vers nous dans les 24 heures, avec une rame en service, et la ville vous versera une prime de mise en service. »`,
      place: g,
      data: { station: g, reward },
      choices: [
        { id: "accepter", label: "Relever le défi", effects: [{ text: `+${fmt(reward)} pi. si une rame dessert ${g} sous 24 h`, tone: "gain" }] },
        { id: "decliner", label: "Décliner poliment", effects: [{ text: "Rien ne bouge", tone: "neutre" }] },
      ],
      defaultChoiceId: "decliner",
    };
  },

  PRESSE: (c) => ({
    kind: "PRESSE",
    title: "Un journaliste enquête sur la ponctualité",
    body: "Le Courrier du Rail prépare un dossier sur les compagnies du réseau. Le journaliste demande une interview et l'accès à vos chiffres de ponctualité.",
    place: null,
    data: { reputation: c.reputation },
    choices: [
      { id: "interview", label: "Accorder l'interview", effects: [{ text: "+5 réputation si vous êtes à 85 % ou plus", tone: "gain" }, { text: "−5 sinon", tone: "risque" }] },
      { id: "silence", label: "Pas de commentaire", effects: [{ text: "−1 réputation", tone: "risque" }] },
    ],
    defaultChoiceId: "silence",
  }),

  RIVAL: (c) => {
    if (c.rivalPairs.length === 0) return null;
    const p = c.pick(c.rivalPairs);
    return {
      kind: "RIVAL",
      title: `Guerre des prix sur ${p.a} – ${p.b}`,
      body: `Une compagnie concurrente affiche des billets à moitié prix sur ${p.a} – ${p.b}, la liaison que vous partagez avec elle. Vos voyageurs hésitent. Suivre, c'est gagner moins par trajet ; ne rien faire, c'est les laisser partir.`,
      place: `${p.a} – ${p.b}`,
      data: { a: p.a, b: p.b, rival: p.rival },
      choices: [
        { id: "suivre", label: "Suivre la baisse", effects: [{ text: "Recettes −15 % sur la liaison pendant 3 h", tone: "cout" }, { text: "+3 réputation", tone: "gain" }] },
        { id: "qualite", label: "Miser sur le service", effects: [{ text: `−${fmt(scaled(60, running(c).length))} pi.`, tone: "cout" }, { text: "Recettes normales", tone: "gain" }] },
        { id: "ignorer", label: "Ignorer", effects: [{ text: "Recettes −30 % sur la liaison pendant 3 h", tone: "risque" }] },
      ],
      defaultChoiceId: "ignorer",
    };
  },

  METEO: (c) => {
    const month = c.now.getUTCMonth() + 1;
    const summer = month >= 5 && month <= 9;
    const cost = scaled(80, running(c).length);
    return summer
      ? {
          kind: "METEO",
          title: "Alerte canicule pour demain",
          body: "Météo-France annonce 38 °C. Dans des voitures sans climatisation d'appoint, les voyageurs vont souffrir, et ils s'en souviendront.",
          place: null,
          data: { cost },
          choices: [
            { id: "equiper", label: "Louer des climatiseurs d'appoint", effects: [{ text: `−${fmt(cost)} pi.`, tone: "cout" }, { text: "Réputation protégée", tone: "gain" }] },
            { id: "rien", label: "Distribuer de l'eau et espérer", effects: [{ text: "−3 réputation", tone: "risque" }] },
          ],
          defaultChoiceId: "rien",
        }
      : {
          kind: "METEO",
          title: "Nuit de gel annoncée",
          body: "Il fera −8 °C cette nuit. Les aiguillages gèlent vite par ce froid, et un train bloqué au petit matin fait mauvaise impression.",
          place: null,
          data: { cost },
          choices: [
            { id: "equiper", label: "Faire chauffer les aiguillages", effects: [{ text: `−${fmt(cost)} pi.`, tone: "cout" }, { text: "Réputation protégée", tone: "gain" }] },
            { id: "rien", label: "Prendre le risque", effects: [{ text: "−3 réputation", tone: "risque" }] },
          ],
          defaultChoiceId: "rien",
        };
  },

  VIP: (c) => {
    const r = running(c);
    if (r.length === 0) return null;
    const t = c.pick(r);
    const cost = scaled(50, r.length);
    return {
      kind: "VIP",
      title: `Une ministre voyage sur ${t.line!.departureStation} → ${t.line!.arrivalStation}`,
      body: `Le cabinet de la ministre des Transports a réservé une place à bord de la ${t.name}. Elle voyage incognito, mais les photographes l'attendront à l'arrivée.`,
      place: t.line!.arrivalStation,
      data: { cost },
      choices: [
        { id: "soigner", label: "Soigner l'accueil à bord", effects: [{ text: `−${fmt(cost)} pi.`, tone: "cout" }, { text: "+4 réputation", tone: "gain" }] },
        { id: "normal", label: "La traiter comme tout le monde", effects: [{ text: "Rien ne bouge", tone: "neutre" }] },
      ],
      defaultChoiceId: "normal",
    };
  },

  OCCASION: (c) => {
    if (c.trains.length >= c.company.maxTrains) return null;
    const price = 120; // une Standard neuve vaut 200 pi.
    return {
      kind: "OCCASION",
      title: "Une rame d'occasion à vendre",
      body: "Une compagnie régionale qui ferme ses portes brade son matériel. Une rame Standard, un peu fatiguée, mais qui roule.",
      place: null,
      data: { price },
      choices: [
        { id: "acheter", label: "L'acheter", effects: [{ text: `−${price} pi. au lieu de 200`, tone: "gain" }, { text: "Usure de départ : 40 %", tone: "cout" }], locked: c.company.balance < price ? "Trésorerie insuffisante" : null },
        { id: "refuser", label: "Laisser passer", effects: [{ text: "Rien ne bouge", tone: "neutre" }] },
      ],
      defaultChoiceId: "refuser",
    };
  },

  TOURISME: (c) => {
    const stations = myStations(c);
    if (stations.length === 0) return null;
    const g = c.pick(stations);
    const cost = scaled(90, running(c).length);
    return {
      kind: "TOURISME",
      title: `L'office du tourisme de ${g} propose une campagne`,
      body: `Affiches dans le métro parisien, encarts dans la presse : l'office du tourisme de ${g} cherche une compagnie partenaire et partage les frais.`,
      place: g,
      data: { station: g, cost },
      choices: [
        { id: "signer", label: "Cofinancer la campagne", effects: [{ text: `−${fmt(cost)} pi.`, tone: "cout" }, { text: `+25 % de recette à ${g} pendant 4 h`, tone: "gain" }] },
        { id: "refuser", label: "Refuser", effects: [{ text: "Rien ne bouge", tone: "neutre" }] },
      ],
      defaultChoiceId: "refuser",
    };
  },

  TRAVAUX: (c) => {
    const stations = myStations(c);
    if (stations.length === 0) return null;
    const g = c.pick(stations);
    const cost = scaled(50, running(c).length);
    return {
      kind: "TRAVAUX",
      title: `Travaux sur les voies autour de ${g}`,
      body: `SNCF Réseau remplace des traverses aux abords de ${g}. Vos trains peuvent passer par une déviation, plus longue et payante, ou rouler au pas dans la zone de travaux.`,
      place: g,
      data: { station: g, cost },
      choices: [
        { id: "deviation", label: "Payer la déviation", effects: [{ text: `−${fmt(cost)} pi.`, tone: "cout" }, { text: "Recettes normales", tone: "gain" }] },
        { id: "subir", label: "Rouler au pas", effects: [{ text: `Recettes −30 % à ${g} pendant 2 h`, tone: "risque" }] },
      ],
      defaultChoiceId: "subir",
    };
  },
};

export const KINDS = Object.keys(MAKERS);

/* ---------- l'application d'un choix ---------- */

export interface Resolution {
  outcome: string;
  tone: Tone;
}

type DecisionRow = {
  id: string;
  kind: string;
  companyId: string;
  data: any;
  choices: any;
  status: string;
  title: string;
};

async function addReputation(companyId: string, delta: number) {
  await prisma.company.update({ where: { id: companyId }, data: { reputationAdjust: { increment: delta } } });
}

async function charge(companyId: string, amount: number, type: string, description: string) {
  // la dépense passe même si la trésorerie devient négative : c'est le prix affiché
  await prisma.$transaction([
    prisma.company.update({ where: { id: companyId }, data: { balance: { decrement: amount } } }),
    prisma.transaction.create({ data: { companyId, type, amount: -amount, description } }),
  ]);
}

async function pay(companyId: string, amount: number, type: string, description: string) {
  await prisma.$transaction([
    prisma.company.update({ where: { id: companyId }, data: { balance: { increment: amount } } }),
    prisma.transaction.create({ data: { companyId, type, amount, description } }),
  ]);
}

const H = 3600_000;

/* Applique le choix et renvoie ce qui s'est passé, en une phrase. Les
   effets durables sont écrits sur la décision elle-même (effectKey…). */
export async function applyChoice(d: DecisionRow, choiceId: string, random = Math.random): Promise<Resolution & { effect?: { key: string; mult: number; hours: number }; goal?: { station: string; reward: number } }> {
  const data = (d.data ?? {}) as Record<string, any>;
  const cid = d.companyId;
  const key = `${d.kind}:${choiceId}`;
  switch (key) {
    case "FISSURE:reparer": {
      const train = await prisma.train.findUnique({ where: { id: data.trainId } });
      if (!train) return { outcome: "La rame n'est plus dans votre parc : rien à réparer.", tone: "neutre" };
      const cost = Math.max(20, Math.round(train.wear * repairCostPerPoint(await staffEffectsFor(cid))));
      await charge(cid, cost, "REPARATION", `Remise à neuf préventive : ${train.name}`);
      await prisma.train.update({ where: { id: train.id }, data: { wear: 0 } });
      return { outcome: `La ${train.name} passe à l'atelier et repart à neuf, pour ${fmt(cost)} pi. Le mécanicien est rassuré.`, tone: "gain" };
    }
    case "FISSURE:rouler": {
      const train = await prisma.train.findUnique({ where: { id: data.trainId } });
      if (!train) return { outcome: "La rame n'est plus dans votre parc.", tone: "neutre" };
      if (random() < 1 / 3) {
        await prisma.$transaction([
          prisma.train.update({ where: { id: train.id }, data: { wear: 100, status: "MAINTENANCE" } }),
          prisma.incident.create({ data: { trainId: train.id, message: `${train.name} : le bogie fissuré a cédé, la rame est en panne` } }),
        ]);
        return { outcome: `Le bogie a cédé en pleine voie. La ${train.name} est en panne et attend une réparation.`, tone: "risque" };
      }
      return { outcome: `La ${train.name} a tenu. Cette fois. Le mécanicien surveille la fissure.`, tone: "neutre" };
    }
    case "FESTIVAL:special": {
      const gain = Number(data.gain) || 150;
      await pay(cid, gain, "EVENEMENT", `Train spécial pour le festival de ${data.station}`);
      return { outcome: `Le train spécial part complet sous les applaudissements : +${fmt(gain)} pi. L'office du tourisme retient votre nom.`, tone: "gain" };
    }
    case "FESTIVAL:tarif":
      await addReputation(cid, -3);
      return { outcome: `Les recettes grimpent à ${data.station} pour deux heures, mais des festivaliers se plaignent des prix.`, tone: "cout", effect: { key: data.station, mult: 1.3, hours: 2 } };
    case "FESTIVAL:rien":
      return { outcome: "Les festivaliers repartent avec les autres compagnies. Rien de perdu, rien de gagné.", tone: "neutre" };
    case "GREVE:negocier":
      await charge(cid, Number(data.prime) || 100, "EVENEMENT", `Prime aux aiguilleurs de ${data.station}`);
      await addReputation(cid, 2);
      return { outcome: "Accord signé. Les aiguilleurs reprennent le poste, et la presse locale salue votre sens du dialogue.", tone: "gain" };
    case "GREVE:interim": {
      await charge(cid, Number(data.interim) || 40, "EVENEMENT", `Aiguilleurs intérimaires à ${data.station}`);
      if (random() < 0.5) {
        await addReputation(cid, -2);
        return { outcome: "Les intérimaires tiennent le poste, mais avec des retards que les voyageurs ont remarqués.", tone: "cout" };
      }
      return { outcome: "Les intérimaires tiennent le poste sans accroc. Personne n'a rien vu.", tone: "gain" };
    }
    case "GREVE:attendre":
      return { outcome: `La grève dure deux heures : vos trajets par ${data.station} rapportent moitié moins le temps qu'elle dure.`, tone: "risque", effect: { key: data.station, mult: 0.5, hours: 2 } };
    case "MAIRE:accepter":
      return { outcome: `Le maire de ${data.station} attend votre ligne. Tracez-la et mettez-y une rame avant demain pour toucher la prime.`, tone: "gain", goal: { station: data.station, reward: Number(data.reward) || 250 } };
    case "MAIRE:decliner":
      return { outcome: "Le maire prend note. Il ira voir ailleurs.", tone: "neutre" };
    case "PRESSE:interview": {
      const rep = await computeReputation(cid);
      if (rep >= 85) {
        await addReputation(cid, 5);
        return { outcome: "L'article est flatteur : « une compagnie ponctuelle, qui a su gagner la confiance des voyageurs ». +5 réputation.", tone: "gain" };
      }
      await addReputation(cid, -5);
      return { outcome: "Le journaliste a épluché vos retards. L'article est sévère. −5 réputation.", tone: "risque" };
    }
    case "PRESSE:silence":
      await addReputation(cid, -1);
      return { outcome: "« La compagnie n'a pas souhaité répondre. » Une ligne dans l'article, qui ne vous rend pas service.", tone: "cout" };
    case "RIVAL:suivre":
      await addReputation(cid, 3);
      return { outcome: `Vous suivez la baisse. Les voyageurs restent, et apprécient : +3 réputation, mais chaque trajet sur ${data.a} – ${data.b} rapporte moins pendant trois heures.`, tone: "cout", effect: { key: `${data.a}|${data.b}`, mult: 0.85, hours: 3 } };
    case "RIVAL:qualite": {
      const n = await prisma.train.count({ where: { companyId: cid, lineId: { not: null } } });
      await charge(cid, scaled(60, n), "EVENEMENT", `Service à bord renforcé sur ${data.a} – ${data.b}`);
      return { outcome: "Café offert, voitures impeccables : vos voyageurs ne vont pas voir ailleurs.", tone: "gain" };
    }
    case "RIVAL:ignorer":
      return { outcome: `Une partie de vos voyageurs file chez la concurrence. Recettes −30 % sur ${data.a} – ${data.b} pendant trois heures.`, tone: "risque", effect: { key: `${data.a}|${data.b}`, mult: 0.7, hours: 3 } };
    case "METEO:equiper":
      await charge(cid, Number(data.cost) || 80, "EVENEMENT", "Équipement contre les intempéries");
      return { outcome: "Le matériel est en place. Vos voyageurs n'ont rien remarqué, et c'est exactement ce qu'il fallait.", tone: "gain" };
    case "METEO:rien":
      await addReputation(cid, -3);
      return { outcome: "Il a fallu gérer des voyageurs mécontents toute la journée. −3 réputation.", tone: "risque" };
    case "VIP:soigner":
      await charge(cid, Number(data.cost) || 50, "EVENEMENT", "Accueil de la ministre à bord");
      await addReputation(cid, 4);
      return { outcome: "La ministre descend du train souriante, devant les photographes. +4 réputation.", tone: "gain" };
    case "VIP:normal":
      return { outcome: "La ministre a voyagé sans histoire. Personne n'en a parlé.", tone: "neutre" };
    case "OCCASION:acheter": {
      const company = await prisma.company.findUnique({ where: { id: cid }, include: { _count: { select: { trains: true } } } });
      if (!company) return { outcome: "Compagnie introuvable.", tone: "neutre" };
      if ((company as any)._count.trains >= company.maxTrains) return { outcome: "Votre dépôt est plein : la vente vous est passée sous le nez.", tone: "neutre" };
      const price = Number(data.price) || 120;
      await prisma.$transaction([
        prisma.company.update({ where: { id: cid }, data: { balance: { decrement: price } } }),
        prisma.train.create({ data: { companyId: cid, name: `Rame ${(company as any)._count.trains + 1}`, model: "STANDARD", wear: 40 } }),
        prisma.transaction.create({ data: { companyId: cid, type: "ACHAT_TRAIN", amount: -price, description: "Rame Standard d'occasion" } }),
      ]);
      return { outcome: `Marché conclu : une rame Standard rejoint votre dépôt pour ${price} pi. Elle attend une affectation.`, tone: "gain" };
    }
    case "OCCASION:refuser":
      return { outcome: "Une autre compagnie a emporté la rame.", tone: "neutre" };
    case "TOURISME:signer":
      await charge(cid, Number(data.cost) || 90, "EVENEMENT", `Campagne touristique à ${data.station}`);
      return { outcome: `Les affiches sont posées : ${data.station} attire du monde, +25 % de recette pendant quatre heures.`, tone: "gain", effect: { key: data.station, mult: 1.25, hours: 4 } };
    case "TOURISME:refuser":
      return { outcome: "L'office du tourisme trouvera un autre partenaire.", tone: "neutre" };
    case "TRAVAUX:deviation":
      await charge(cid, Number(data.cost) || 50, "EVENEMENT", `Déviation autour de ${data.station}`);
      return { outcome: "Vos trains contournent le chantier. Quelques minutes de plus, aucun voyageur perdu.", tone: "gain" };
    case "TRAVAUX:subir":
      return { outcome: `Vos trains roulent au pas autour de ${data.station} : recettes −30 % pendant deux heures.`, tone: "risque", effect: { key: data.station, mult: 0.7, hours: 2 } };
  }
  return { outcome: "C'est noté. Le réseau suit son cours.", tone: "neutre" };
}

/* Trancher : verrouille la décision (un seul choix, même avec deux onglets
   ouverts), applique l'effet, écrit le résultat. */
export async function resolveDecision(decisionId: string, companyId: string, choiceId: string, expired = false) {
  const d = (await prisma.decision.findUnique({ where: { id: decisionId } })) as (DecisionRow & { companyId: string }) | null;
  if (!d || d.companyId !== companyId) return { error: "Décision introuvable", status: 404 } as const;
  if (d.status !== "OUVERTE") return { error: "Cette décision est déjà prise", status: 409 } as const;
  const choice = (d.choices as Choice[]).find((c) => c.id === choiceId);
  if (!choice) return { error: "Choix inconnu", status: 400 } as const;

  const claimed = await prisma.decision.updateMany({
    where: { id: d.id, status: "OUVERTE" },
    data: { status: expired ? "EXPIREE" : "TRANCHEE", chosenId: choiceId, resolvedAt: new Date() },
  });
  if (claimed.count === 0) return { error: "Cette décision est déjà prise", status: 409 } as const;

  const r = await applyChoice(d, choiceId);
  const now = Date.now();
  await prisma.decision.update({
    where: { id: d.id },
    data: {
      outcome: expired ? `Sans réponse de votre part : ${r.outcome.charAt(0).toLowerCase()}${r.outcome.slice(1)}` : r.outcome,
      ...(r.effect ? { effectKey: r.effect.key, effectMultiplier: r.effect.mult, effectEndsAt: new Date(now + r.effect.hours * H) } : {}),
      ...(r.goal ? { goalStation: r.goal.station, goalReward: r.goal.reward, goalDeadline: new Date(now + 24 * H) } : {}),
    },
  });
  return { ok: true, outcome: r.outcome, tone: r.tone } as const;
}

/* Les choix bloqués (plus de rame libre, trésorerie) sont recalculés à la lecture. */
export async function lockedReasons(d: { kind: string; companyId: string; data: any }, choices: Choice[]): Promise<Choice[]> {
  if (d.kind === "FESTIVAL") {
    const idle = await prisma.train.count({ where: { companyId: d.companyId, lineId: null, status: "IDLE", model: { not: "COUCHETTES" } } });
    return choices.map((c) => (c.id === "special" ? { ...c, locked: idle > 0 ? null : "Il faut une rame libre au dépôt" } : c));
  }
  if (d.kind === "OCCASION") {
    const company = await prisma.company.findUnique({ where: { id: d.companyId }, include: { _count: { select: { trains: true } } } });
    const price = Number((d.data ?? {}).price) || 120;
    const full = company ? (company as any)._count.trains >= company.maxTrains : true;
    return choices.map((c) => (c.id === "acheter" ? { ...c, locked: full ? "Votre dépôt est plein" : company && company.balance < price ? "Trésorerie insuffisante" : null } : c));
  }
  return choices;
}

/* ---------- les effets en cours, pour la simulation ---------- */

export async function activeDecisionEffects(now = new Date()) {
  const rows = (await prisma.decision.findMany({
    where: { effectEndsAt: { gt: now } },
    select: { companyId: true, effectKey: true, effectMultiplier: true },
  })) as { companyId: string; effectKey: string | null; effectMultiplier: number | null }[];
  const map = new Map<string, { key: string; mult: number }[]>();
  for (const r of rows) {
    if (!r.effectKey || !r.effectMultiplier) continue;
    const list = map.get(r.companyId) ?? [];
    list.push({ key: r.effectKey, mult: r.effectMultiplier });
    map.set(r.companyId, list);
  }
  return map;
}

/* Multiplicateur d'une ligne A–B : les effets de gare et de liaison se cumulent. */
export function decisionMultiplier(effects: { key: string; mult: number }[] | undefined, dep: string, arr: string) {
  if (!effects) return 1;
  let m = 1;
  for (const e of effects) {
    if (e.key.includes("|")) {
      const [a, b] = e.key.split("|");
      if ((a === dep && b === arr) || (a === arr && b === dep)) m *= e.mult;
    } else if (e.key === dep || e.key === arr) {
      m *= e.mult;
    }
  }
  return m;
}

/* ---------- le passage régulier (toutes les cinq minutes) ---------- */

type Push = (companyId: string, title: string, body: string) => Promise<void>;

export async function runDecisions(push: Push, now = new Date(), random = Math.random) {
  // 1. échéances : la réponse par défaut s'applique
  const expired = (await prisma.decision.findMany({
    where: { status: "OUVERTE", expiresAt: { lte: now } },
    select: { id: true, companyId: true, defaultChoiceId: true },
  })) as { id: string; companyId: string; defaultChoiceId: string }[];
  for (const d of expired) {
    await resolveDecision(d.id, d.companyId, d.defaultChoiceId, true).catch((err) => console.error("[décisions] échéance :", (err as Error).message));
  }

  // 2. promesses au maire : une rame en service vers la gare avant l'échéance
  const goals = (await prisma.decision.findMany({
    where: { goalDone: false, goalStation: { not: null }, goalDeadline: { gt: now } },
    select: { id: true, companyId: true, goalStation: true, goalReward: true },
  })) as { id: string; companyId: string; goalStation: string; goalReward: number }[];
  for (const g of goals) {
    const served = await prisma.train.count({
      where: { companyId: g.companyId, line: { OR: [{ departureStation: g.goalStation }, { arrivalStation: g.goalStation }] } },
    });
    if (served === 0) continue;
    const done = await prisma.decision.updateMany({ where: { id: g.id, goalDone: false }, data: { goalDone: true } });
    if (done.count === 0) continue;
    await pay(g.companyId, g.goalReward, "EVENEMENT", `Prime de mise en service versée par ${g.goalStation}`);
    await push(g.companyId, `Promesse tenue à ${g.goalStation}`, `Le maire vous verse ${fmt(g.goalReward)} pi. de prime de mise en service.`).catch(() => undefined);
  }

  // 3. nouvelles décisions : jamais la nuit
  const h = parisHour(now);
  if (h >= QUIET_FROM || h < QUIET_TO) return;

  const candidates = (await prisma.company.findMany({
    where: {
      lastActiveAt: { gt: new Date(now.getTime() - ACTIVE_WITHIN_MS) },
      OR: [{ nextDecisionAt: null }, { nextDecisionAt: { lte: now } }],
      trains: { some: { lineId: { not: null } } },
    },
    select: { id: true, balance: true, maxTrains: true, nextDecisionAt: true },
    take: 200,
  })) as { id: string; balance: number; maxTrains: number; nextDecisionAt: Date | null }[];

  for (const company of candidates) {
    const open = await prisma.decision.count({ where: { companyId: company.id, status: "OUVERTE" } });
    if (open > 0) continue;
    // première fois : on ne pose pas la décision tout de suite, on la programme
    if (company.nextDecisionAt === null) {
      await prisma.company.update({ where: { id: company.id }, data: { nextDecisionAt: new Date(now.getTime() + FIRST_DELAY_MS) } });
      continue;
    }
    const draft = await draftFor(company, now, random);
    const gap = GAP_MIN_MS + random() * (GAP_MAX_MS - GAP_MIN_MS);
    await prisma.company.update({ where: { id: company.id }, data: { nextDecisionAt: new Date(now.getTime() + gap) } });
    if (!draft) continue;
    await prisma.decision.create({
      data: {
        companyId: company.id,
        kind: draft.kind,
        title: draft.title,
        body: draft.body,
        place: draft.place ?? null,
        data: (draft.data ?? {}) as any,
        choices: draft.choices as any,
        defaultChoiceId: draft.defaultChoiceId,
        expiresAt: new Date(now.getTime() + DECISION_TTL_MS),
      },
    });
    await push(company.id, draft.title, "Une décision vous attend. Sans réponse d'ici deux heures, le réseau tranchera pour vous.").catch(() => undefined);
  }
}

/* Choisit une situation qui a du sens pour cette compagnie, en évitant de
   reposer la même que les deux dernières fois. */
export async function draftFor(company: { id: string; balance: number; maxTrains: number }, now = new Date(), random = Math.random): Promise<Draft | null> {
  const [trains, lines, recent, reputation, shared] = await Promise.all([
    prisma.train.findMany({ where: { companyId: company.id }, include: { line: true } }),
    prisma.line.findMany({ where: { companyId: company.id }, select: { id: true, departureStation: true, arrivalStation: true } }),
    prisma.decision.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "desc" }, take: 2, select: { kind: true } }),
    computeReputation(company.id),
    rivalPairsFor(company.id),
  ]);
  const ctx: Ctx = {
    company,
    trains: trains as Ctx["trains"],
    lines: lines as Ctx["lines"],
    reputation,
    rivalPairs: shared,
    now,
    pick: <T,>(xs: T[]) => xs[Math.floor(random() * xs.length)],
  };
  const avoid = new Set((recent as { kind: string }[]).map((r) => r.kind));
  const order = [...KINDS].sort(() => random() - 0.5);
  const preferred = order.filter((k) => !avoid.has(k)).concat(order.filter((k) => avoid.has(k)));
  for (const k of preferred) {
    const d = MAKERS[k](ctx);
    if (d) return d;
  }
  return null;
}

async function rivalPairsFor(companyId: string) {
  const mine = (await prisma.line.findMany({
    where: { companyId, trains: { some: {} } },
    select: { departureStation: true, arrivalStation: true },
  })) as { departureStation: string; arrivalStation: string }[];
  if (mine.length === 0) return [];
  const others = (await prisma.line.findMany({
    where: {
      companyId: { not: companyId },
      trains: { some: {} },
      OR: mine.map((l) => ({
        OR: [
          { departureStation: l.departureStation, arrivalStation: l.arrivalStation },
          { departureStation: l.arrivalStation, arrivalStation: l.departureStation },
        ],
      })),
    },
    select: { departureStation: true, arrivalStation: true, company: { select: { name: true } } },
    take: 20,
  })) as { departureStation: string; arrivalStation: string; company: { name: string } }[];
  return others.map((o) => ({ a: o.departureStation, b: o.arrivalStation, rival: o.company.name }));
}

/* Ce que voit le joueur : les décisions ouvertes, et les dernières tranchées. */
export async function listForCompany(companyId: string) {
  const rows = (await prisma.decision.findMany({
    where: { companyId, OR: [{ status: "OUVERTE" }, { resolvedAt: { gt: new Date(Date.now() - 24 * H) } }] },
    orderBy: { createdAt: "desc" },
    take: 12,
  })) as any[];
  return Promise.all(
    rows.map(async (d) => ({
      id: d.id,
      kind: d.kind,
      title: d.title,
      body: d.body,
      place: d.place,
      createdAt: d.createdAt,
      expiresAt: d.expiresAt,
      defaultChoiceId: d.defaultChoiceId,
      choices: d.status === "OUVERTE" ? await lockedReasons(d, d.choices as Choice[]) : d.choices,
      status: d.status,
      chosenId: d.chosenId,
      outcome: d.outcome,
      effectEndsAt: d.effectEndsAt,
      goalStation: d.goalStation,
      goalDeadline: d.goalDeadline,
      goalDone: d.goalDone,
    }))
  );
}
