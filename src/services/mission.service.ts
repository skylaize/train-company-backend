import { prisma } from "../prisma";
import { CLIENTS, clientById, levelFromReputation, FAILURE_PENALTY, REPUTATION_MAX } from "./client.service";

/* ============================================================
   Génération et cycle de vie des ordres de mission.

   Les missions sont tirées au sort, mais dans des bornes : la quantité
   dépend du grade du joueur et de sa relation avec le client. Un tirage
   libre donnerait des ordres infaisables à un débutant et dérisoires à
   un vétéran — dans les deux cas le système perd tout intérêt.
   ============================================================ */

/* Valeur de référence d'une cargaison, alignée sur CARGO_TEMPLATES.
   Sert uniquement à calculer une prime de mission cohérente avec ce que
   les mêmes livraisons rapporteraient au marché. */
const CARGO_BASE: Record<string, number> = {
  "Céréales": 120,
  "Acier": 180,
  "Conteneurs": 90,
  "Bois": 100,
  "Automobiles": 150,
  "Produits chimiques": 140,
  "Verre soufflé": 230,
  "Œuvres d'art": 340,
  "Produits pharmaceutiques réfrigérés": 190,
};

const OFFER_WINDOW_H = 6; // délai pour accepter ou refuser
const COOLDOWN_H = 2; // repos du client après un refus ou un échec

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* Quantité demandée : 2 au départ, jusqu'à 8 pour un Baron du rail
   déjà bien installé chez le client. Le +/- 1 aléatoire évite que deux
   missions successives soient identiques. */
export function targetFor(gradeId: number, clientLevel: number) {
  const base = 2 + Math.floor(gradeId / 2) + clientLevel;
  const jitter = Math.random() < 0.5 ? 0 : 1;
  return Math.max(2, Math.min(8, base + jitter));
}

/* Délai de livraison : plus la commande est grosse, plus on laisse de temps.
   24 h pour deux cargaisons, jusqu'à 72 h pour huit. */
export function deadlineHoursFor(target: number) {
  return Math.min(72, 24 + (target - 2) * 8);
}

/* Prime : ce que les mêmes livraisons rapporteraient au marché, majoré de
   35 %. En dessous, accepter une contrainte de délai n'aurait aucun intérêt. */
export function rewardFor(cargoType: string, target: number) {
  const base = CARGO_BASE[cargoType] ?? 120;
  return Math.round(base * target * 0.35);
}

export function repRewardFor(target: number) {
  return 8 + target;
}

/* Propose un ordre pour chaque client accessible et sans ordre en cours. */
/* Un abonné reçoit deux ordres par chargeur au lieu d'un. C'est du choix, pas
   du rendement : la prime et la réputation d'un ordre sont identiques pour
   tout le monde, l'abonné a seulement plus d'options sur la table. */
export async function refreshMissionsFor(companyId: string, gradeId: number, isPremium = false) {
  const ordersPerClient = isPremium ? 2 : 1;
  const [relations, missions] = await Promise.all([
    prisma.clientRelation.findMany({ where: { companyId } }),
    prisma.mission.findMany({
      where: { companyId, status: { in: ["PROPOSEE", "ACCEPTEE"] } },
    }),
  ]);

  const repByClient = new Map<string, number>(
    (relations as Array<{ clientId: string; reputation: number }>).map((r) => [r.clientId, r.reputation])
  );
  const openByClient = new Map<string, number>();
  (missions as Array<{ clientId: string }>).forEach((m) => {
    openByClient.set(m.clientId, (openByClient.get(m.clientId) ?? 0) + 1);
  });

  const now = Date.now();

  for (const client of CLIENTS) {
    if (client.minGradeId > gradeId) continue;
    if ((openByClient.get(client.id) ?? 0) >= ordersPerClient) continue;

    /* Repos du client après un refus ou un échec : sans ça, refuser ne
       coûterait rien puisqu'un nouvel ordre arriverait dans la seconde.
       On ne l'applique que si le chargeur n'a aucun ordre ouvert — sinon
       le deuxième ordre d'un abonné ne serait jamais créé, l'offre en cours
       repoussant elle-même l'échéance. */
    const hasOpen = (openByClient.get(client.id) ?? 0) > 0;
    const last = hasOpen ? null : await prisma.mission.findFirst({
      where: { companyId, clientId: client.id },
      orderBy: { createdAt: "desc" },
      select: { status: true, createdAt: true, offerUntil: true },
    });
    if (last) {
      const ref = last.status === "PROPOSEE" ? last.offerUntil : last.createdAt;
      if (now - new Date(ref).getTime() < COOLDOWN_H * 3600_000) continue;
    }

    const rep = repByClient.get(client.id) ?? 0;
    const level = levelFromReputation(rep).level;
    const cargoType = pick(client.cargoTypes);
    const target = targetFor(gradeId, level);

    await prisma.mission.create({
      data: {
        companyId,
        clientId: client.id,
        cargoType,
        target,
        reward: rewardFor(cargoType, target),
        repReward: repRewardFor(target),
        status: "PROPOSEE",
        offerUntil: new Date(now + OFFER_WINDOW_H * 3600_000),
      },
    });
    openByClient.set(client.id, (openByClient.get(client.id) ?? 0) + 1);
  }
}

/* Appelé à chaque livraison de fret : fait avancer l'ordre correspondant. */
export async function creditDelivery(companyId: string, cargoType: string) {
  const mission = await prisma.mission.findFirst({
    where: { companyId, cargoType, status: "ACCEPTEE" },
    orderBy: { createdAt: "asc" },
  });
  if (!mission) return null;

  const progress = mission.progress + 1;

  if (progress < mission.target) {
    await prisma.mission.update({ where: { id: mission.id }, data: { progress } });
    return null;
  }

  // ordre honoré : prime, réputation, trace au grand livre
  const client = clientById(mission.clientId);
  await prisma.$transaction([
    prisma.mission.update({
      where: { id: mission.id },
      data: { progress, status: "REUSSIE" },
    }),
    prisma.company.update({
      where: { id: companyId },
      data: { balance: { increment: mission.reward } },
    }),
    prisma.transaction.create({
      data: {
        companyId,
        type: "MISSION",
        amount: mission.reward,
        description: `Ordre honoré pour ${client?.name ?? mission.clientId} — ${mission.target} × ${mission.cargoType}`,
      },
    }),
  ]);

  await bumpReputation(companyId, mission.clientId, mission.repReward);
  return { clientName: client?.name ?? mission.clientId, reward: mission.reward };
}

async function bumpReputation(companyId: string, clientId: string, delta: number) {
  const existing = await prisma.clientRelation.findUnique({
    where: { companyId_clientId: { companyId, clientId } },
  });

  const current = existing?.reputation ?? 0;
  const next = Math.max(0, Math.min(REPUTATION_MAX, current + delta));
  const level = levelFromReputation(next).level;

  if (existing) {
    await prisma.clientRelation.update({
      where: { id: existing.id },
      data: { reputation: next, level },
    });
  } else {
    await prisma.clientRelation.create({
      data: { companyId, clientId, reputation: next, level },
    });
  }
}

/* Passe les offres non répondues et les ordres en retard à l'échec.
   Tourne dans la boucle de simulation. */
export async function expireMissions() {
  const now = new Date();

  const stale = await prisma.mission.findMany({
    where: {
      OR: [
        { status: "PROPOSEE", offerUntil: { lt: now } },
        { status: "ACCEPTEE", dueAt: { lt: now } },
      ],
    },
    select: { id: true, status: true, companyId: true, clientId: true },
  });
  if (stale.length === 0) return;

  for (const m of stale as Array<{ id: string; status: string; companyId: string; clientId: string }>) {
    await prisma.mission.update({ where: { id: m.id }, data: { status: "ECHOUEE" } });

    /* Une offre ignorée ne coûte rien : le joueur n'a rien promis.
       Un ordre accepté puis non tenu, si. C'est ce qui donne du poids à
       l'acceptation — sans cela, accepter serait toujours gratuit. */
    if (m.status === "ACCEPTEE") {
      await bumpReputation(m.companyId, m.clientId, -FAILURE_PENALTY);
      const client = clientById(m.clientId);
      await prisma.transaction.create({
        data: {
          companyId: m.companyId,
          type: "MISSION",
          amount: 0,
          description: `Ordre non honoré — ${client?.name ?? m.clientId} retire sa confiance`,
        },
      });
    }
  }
}

/* Marchandises à garantir sur le marché : sans ça, un ordre portant sur une
   cargaison qui n'apparaît jamais serait impossible à tenir, et le joueur
   perdrait de la réputation sans avoir rien fait de mal. */
export async function requiredCargoTypes(): Promise<Set<string>> {
  const active = await prisma.mission.findMany({
    where: { status: "ACCEPTEE" },
    select: { cargoType: true },
  });
  return new Set((active as Array<{ cargoType: string }>).map((m) => m.cargoType));
}
