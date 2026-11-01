import { prisma } from "../prisma";
import { buildLeaderRows } from "./leaderboard.service";
import { computeCareerStatus, RANK_DEFINITIONS } from "./career.service";
import { sendToCompany } from "./push.service";

/* ============================================================
   2.5 : le compagnonnage.

   Un joueur installé accompagne un nouveau venu. Le nouveau a quelqu'un à qui
   poser ses questions ; le tuteur voit où en est son apprenti (grade, rames
   en panne, facture d'énergie impayée…) et peut lui laisser un mot. Chaque
   grade franchi par l'apprenti rapporte aux deux ; au grade de Baron du rail,
   l'apprenti est diplômé et la place du tuteur se libère.

   Garde-fous :
   - les primes viennent des grades de l'apprenti, qui demandent du vrai jeu
     (rames, lignes, recettes, réputation) : pas de transfert d'argent entre
     joueurs, rien à gagner en se créant un faux apprenti ;
   - trois apprentis au plus par tuteur, un tuteur à la fois par apprenti ;
   - un apprenti absent une semaine libère la place ;
   - des mots courts, en nombre limité : ce n'est pas une messagerie.
   ============================================================ */

export const MENTOR_MIN_GRADE = 3; // Baron du rail
export const MENTOR_MIN_DAYS = 14;
export const MAX_APPRENTICES = 3;
export const APPRENTICE_MAX_DAYS = 14;
export const APPRENTICE_MAX_GRADE = 1; // on choisit un tuteur avant d'être Chef de réseau
export const GRADUATE_GRADE = 3;
export const INACTIVE_DAYS = 7;
export const NOTE_MAX = 280;
export const NOTES_PER_DAY = 10;
// [prime de l'apprenti, prime du tuteur], par grade atteint
export const MENTOR_REWARDS: Record<number, [number, number]> = { 1: [300, 500], 2: [600, 1000], 3: [1000, 2000] };
export const MASTER_TITLE = "Maître de quai"; // 3 apprentis diplômés
export const MASTER_GRADUATES = 3;

const DAY = 86_400_000;
const ageDays = (d: Date) => (Date.now() - new Date(d).getTime()) / DAY;

type Co = { id: string; name: string; liveryColor: string; createdAt: Date; lastActiveAt: Date | null; balance: number; fuelBlocked: boolean; mentorOpen: boolean; mentorPitch: string | null };
const CO_SELECT = { id: true, name: true, liveryColor: true, createdAt: true, lastActiveAt: true, balance: true, fuelBlocked: true, mentorOpen: true, mentorPitch: true } as const;
type Ship = { id: string; mentorId: string; apprenticeId: string; gradeReached: number; startedAt: Date; endedAt: Date | null; endReason: string | null };

async function gradeMap() {
  const rows = await buildLeaderRows();
  return new Map(rows.map((r) => [r.id, r.gradeId]));
}
const gradeName = (id: number) => RANK_DEFINITIONS[id]?.name ?? RANK_DEFINITIONS[0].name;

export async function graduates(mentorId: string) {
  return prisma.mentorship.count({ where: { mentorId, endReason: "DIPLOME" } });
}

/* Le titre « Maître de quai », pour la liste des titres débloqués. */
export async function mentorTitles(companyId: string): Promise<string[]> {
  const n = await graduates(companyId).catch(() => 0);
  return n >= MASTER_GRADUATES ? [MASTER_TITLE] : [];
}

async function notesOf(mentorshipId: string) {
  return (await prisma.mentorNote.findMany({ where: { mentorshipId }, orderBy: { createdAt: "desc" }, take: 20 })) as { id: string; fromId: string; text: string; createdAt: Date }[];
}

/* ---------------- ce que voit chacun ---------------- */

export async function mentorView(companyId: string) {
  const [me, grades, asMentor, asApprentice] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: CO_SELECT }) as Promise<Co | null>,
    gradeMap(),
    prisma.mentorship.findMany({ where: { mentorId: companyId, endedAt: null } }) as Promise<Ship[]>,
    prisma.mentorship.findFirst({ where: { apprenticeId: companyId, endedAt: null } }) as Promise<Ship | null>,
  ]);
  if (!me) return null;
  const myGrade = grades.get(companyId) ?? 0;
  const canMentor = myGrade >= MENTOR_MIN_GRADE && ageDays(me.createdAt) >= MENTOR_MIN_DAYS;
  const everHadMentor = await prisma.mentorship.count({ where: { apprenticeId: companyId } });
  const canBeApprentice = !asApprentice && asMentor.length === 0 && ageDays(me.createdAt) < APPRENTICE_MAX_DAYS && myGrade <= APPRENTICE_MAX_GRADE;

  // côté tuteur : un état de chaque apprenti, de quoi conseiller sans lui demander
  const apprentices = await Promise.all(
    asMentor.map(async (m) => {
      const [c, career, broken, notes] = await Promise.all([
        prisma.company.findUnique({ where: { id: m.apprenticeId }, select: { ...CO_SELECT, _count: { select: { trains: true, lines: true } } } }) as Promise<(Co & { _count: { trains: number; lines: number } }) | null>,
        computeCareerStatus(m.apprenticeId).catch(() => null),
        prisma.train.count({ where: { companyId: m.apprenticeId, status: "MAINTENANCE", workshopUntil: null } }),
        notesOf(m.id),
      ]);
      if (!c) return null;
      return {
        mentorshipId: m.id,
        id: c.id,
        name: c.name,
        livery: c.liveryColor,
        since: m.startedAt,
        lastActiveAt: c.lastActiveAt,
        balance: c.balance,
        trains: c._count.trains,
        lines: c._count.lines,
        broken,
        fuelBlocked: c.fuelBlocked,
        grade: career?.currentRank.name ?? gradeName(0),
        gradeId: career?.currentRank.id ?? 0,
        next: career?.nextRank ? { name: career.nextRank.name, requirements: career.nextRank.requirements } : null,
        nextReward: MENTOR_REWARDS[(career?.currentRank.id ?? 0) + 1] ?? null,
        notes: notes.map((n) => ({ id: n.id, mine: n.fromId === companyId, text: n.text, at: n.createdAt })),
      };
    })
  );

  // côté apprenti : son tuteur, ou la liste des tuteurs disponibles
  let mentor = null;
  if (asApprentice) {
    const [c, notes] = await Promise.all([
      prisma.company.findUnique({ where: { id: asApprentice.mentorId }, select: CO_SELECT }) as Promise<Co | null>,
      notesOf(asApprentice.id),
    ]);
    if (c) {
      mentor = {
        mentorshipId: asApprentice.id,
        id: c.id,
        name: c.name,
        livery: c.liveryColor,
        pitch: c.mentorPitch,
        grade: gradeName(grades.get(c.id) ?? 0),
        lastActiveAt: c.lastActiveAt,
        since: asApprentice.startedAt,
        myGrade: gradeName(myGrade),
        nextReward: MENTOR_REWARDS[myGrade + 1] ?? null,
        notes: notes.map((n) => ({ id: n.id, mine: n.fromId === companyId, text: n.text, at: n.createdAt })),
      };
    }
  }
  const available = canBeApprentice ? await availableMentors(companyId, grades) : [];

  return {
    rules: {
      mentorMinGrade: gradeName(MENTOR_MIN_GRADE),
      mentorMinDays: MENTOR_MIN_DAYS,
      maxApprentices: MAX_APPRENTICES,
      apprenticeMaxDays: APPRENTICE_MAX_DAYS,
      graduateGrade: gradeName(GRADUATE_GRADE),
      rewards: Object.entries(MENTOR_REWARDS).map(([g, [a, m]]) => ({ grade: gradeName(Number(g)), apprentice: a, mentor: m })),
      masterTitle: MASTER_TITLE,
      masterGraduates: MASTER_GRADUATES,
    },
    me: { open: me.mentorOpen, pitch: me.mentorPitch, canMentor, graduates: await graduates(companyId), grade: gradeName(myGrade) },
    apprentices: apprentices.filter(Boolean),
    mentor,
    canBeApprentice,
    hadMentor: everHadMentor > 0,
    daysLeft: Math.max(0, Math.ceil(APPRENTICE_MAX_DAYS - ageDays(me.createdAt))),
    available,
  };
}

/* Les tuteurs qui acceptent un apprenti : ceux qui ont une place, les plus
   actifs d'abord (un tuteur absent ne sert à rien). */
async function availableMentors(apprenticeId: string, grades: Map<string, number>) {
  const open = (await prisma.company.findMany({
    where: { mentorOpen: true, id: { not: apprenticeId }, lastActiveAt: { gte: new Date(Date.now() - 3 * DAY) } },
    select: CO_SELECT,
  })) as Co[];
  const eligible = open.filter((c) => (grades.get(c.id) ?? 0) >= MENTOR_MIN_GRADE && ageDays(c.createdAt) >= MENTOR_MIN_DAYS);
  if (!eligible.length) return [];
  const load = (await (prisma.mentorship.groupBy as any)({ by: ["mentorId"], where: { mentorId: { in: eligible.map((c) => c.id) }, endedAt: null }, _count: { _all: true } })) as { mentorId: string; _count: { _all: number } }[];
  const grads = (await (prisma.mentorship.groupBy as any)({ by: ["mentorId"], where: { mentorId: { in: eligible.map((c) => c.id) }, endReason: "DIPLOME" }, _count: { _all: true } })) as { mentorId: string; _count: { _all: number } }[];
  const loadOf = new Map(load.map((l) => [l.mentorId, l._count._all]));
  const gradOf = new Map(grads.map((l) => [l.mentorId, l._count._all]));
  return eligible
    .filter((c) => (loadOf.get(c.id) ?? 0) < MAX_APPRENTICES)
    .sort((a, b) => new Date(b.lastActiveAt ?? 0).getTime() - new Date(a.lastActiveAt ?? 0).getTime())
    .slice(0, 12)
    .map((c) => ({
      id: c.id,
      name: c.name,
      livery: c.liveryColor,
      pitch: c.mentorPitch,
      grade: gradeName(grades.get(c.id) ?? 0),
      lastActiveAt: c.lastActiveAt,
      apprentices: loadOf.get(c.id) ?? 0,
      graduates: gradOf.get(c.id) ?? 0,
    }));
}

/* 2.5 : faut-il inviter cette compagnie à devenir tuteur ? (une petite carte
   sur le tableau de bord, tant qu'elle ne s'est ni inscrite ni l'a fermée) */
export const INVITE_HINT = "tuteur-invite";
export async function mentorInvite(companyId: string) {
  const c = (await prisma.company.findUnique({ where: { id: companyId }, select: { createdAt: true, mentorOpen: true, hintsSeen: true } })) as
    | { createdAt: Date; mentorOpen: boolean; hintsSeen: string | null }
    | null;
  if (!c || c.mentorOpen || (c.hintsSeen ?? "").split(",").includes(INVITE_HINT) || ageDays(c.createdAt) < MENTOR_MIN_DAYS) return { show: false };
  const grade = (await gradeMap()).get(companyId) ?? 0;
  if (grade < MENTOR_MIN_GRADE) return { show: false };
  const perGraduate = Object.values(MENTOR_REWARDS).reduce((n, [, m]) => n + m, 0);
  return { show: true, perGraduate, maxApprentices: MAX_APPRENTICES, masterTitle: MASTER_TITLE };
}

/* ---------------- les gestes ---------------- */

export async function setMentorOpen(companyId: string, open: boolean, pitch: string | null) {
  const grades = await gradeMap();
  const me = (await prisma.company.findUnique({ where: { id: companyId }, select: { createdAt: true } })) as { createdAt: Date } | null;
  if (!me) return { ok: false as const, error: "Compagnie introuvable" };
  if (open && ((grades.get(companyId) ?? 0) < MENTOR_MIN_GRADE || ageDays(me.createdAt) < MENTOR_MIN_DAYS)) {
    return { ok: false as const, error: `Il faut être ${gradeName(MENTOR_MIN_GRADE)} et jouer depuis ${MENTOR_MIN_DAYS} jours pour devenir tuteur` };
  }
  const clean = pitch ? pitch.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 140) || null : null;
  await prisma.company.update({ where: { id: companyId }, data: { mentorOpen: open, mentorPitch: clean } });
  return { ok: true as const };
}

export async function chooseMentor(apprenticeId: string, mentorId: string) {
  const view = await mentorView(apprenticeId);
  if (!view) return { ok: false as const, error: "Compagnie introuvable" };
  if (!view.canBeApprentice) return { ok: false as const, error: "Le compagnonnage est réservé aux compagnies de moins de deux semaines, avant le grade de Chef de réseau" };
  if (!view.available.some((m) => m.id === mentorId)) return { ok: false as const, error: "Ce tuteur n'a plus de place" };
  // les grades déjà atteints avant le compagnonnage ne rapportent rien : seuls ceux qu'on franchit ensemble
  const current = (await computeCareerStatus(apprenticeId).catch(() => null))?.currentRank.id ?? 0;
  const ship = await prisma.mentorship.create({ data: { mentorId, apprenticeId, gradeReached: current } });
  const me = (await prisma.company.findUnique({ where: { id: apprenticeId }, select: { name: true } })) as { name: string } | null;
  await sendToCompany(mentorId, { title: "Nouvel apprenti", body: `${me?.name ?? "Une compagnie"} vous a choisi comme tuteur. Passez lui dire bonjour !`, url: "/dashboard", tag: "compagnonnage" }).catch(() => undefined);
  return { ok: true as const, id: ship.id };
}

export async function endMentorship(companyId: string, mentorshipId: string) {
  const m = (await prisma.mentorship.findFirst({ where: { id: mentorshipId, endedAt: null, OR: [{ mentorId: companyId }, { apprenticeId: companyId }] } })) as Ship | null;
  if (!m) return { ok: false as const, error: "Compagnonnage introuvable" };
  const byMentor = m.mentorId === companyId;
  await prisma.mentorship.update({ where: { id: m.id }, data: { endedAt: new Date(), endReason: byMentor ? "TUTEUR" : "APPRENTI" } });
  return { ok: true as const };
}

export async function sendNote(companyId: string, mentorshipId: string, raw: string) {
  const text = String(raw ?? "").replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").trim().slice(0, NOTE_MAX);
  if (text.length < 2) return { ok: false as const, error: "Message vide" };
  const m = (await prisma.mentorship.findFirst({ where: { id: mentorshipId, endedAt: null, OR: [{ mentorId: companyId }, { apprenticeId: companyId }] } })) as Ship | null;
  if (!m) return { ok: false as const, error: "Compagnonnage introuvable" };
  const today = await prisma.mentorNote.count({ where: { mentorshipId, fromId: companyId, createdAt: { gte: new Date(Date.now() - DAY) } } });
  if (today >= NOTES_PER_DAY) return { ok: false as const, error: `${NOTES_PER_DAY} messages par jour au plus : passez par Discord pour discuter plus longuement` };
  await prisma.mentorNote.create({ data: { mentorshipId, fromId: companyId, text } });
  const to = m.mentorId === companyId ? m.apprenticeId : m.mentorId;
  const from = (await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } })) as { name: string } | null;
  await sendToCompany(to, { title: m.mentorId === companyId ? "Un mot de votre tuteur" : "Un mot de votre apprenti", body: `${from?.name ?? ""} : ${text.slice(0, 120)}`, url: "/dashboard", tag: "compagnonnage" }).catch(() => undefined);
  return { ok: true as const };
}

/* ---------------- le passage régulier ---------------- */

/* Primes des grades franchis, diplômes, et places libérées par les absents.
   Toutes les dix minutes : il y a peu de compagnonnages en cours. */
export async function checkMentorships() {
  const ships = (await prisma.mentorship.findMany({ where: { endedAt: null } })) as Ship[];
  for (const m of ships) {
    try {
      const c = (await prisma.company.findUnique({ where: { id: m.apprenticeId }, select: { name: true, lastActiveAt: true, createdAt: true } })) as
        | { name: string; lastActiveAt: Date | null; createdAt: Date }
        | null;
      if (!c) {
        await prisma.mentorship.update({ where: { id: m.id }, data: { endedAt: new Date(), endReason: "APPRENTI" } });
        continue;
      }
      const career = await computeCareerStatus(m.apprenticeId);
      const grade = career.currentRank.id;
      for (let g = m.gradeReached + 1; g <= Math.min(grade, GRADUATE_GRADE); g++) {
        const reward = MENTOR_REWARDS[g];
        if (!reward) continue;
        // le palier ne se paie qu'une fois, même si deux passages se croisent
        const moved = await prisma.mentorship.updateMany({ where: { id: m.id, gradeReached: g - 1 }, data: { gradeReached: g } });
        if (!moved.count) break;
        const [ap, mp] = reward;
        const mentor = (await prisma.company.findUnique({ where: { id: m.mentorId }, select: { name: true } })) as { name: string } | null;
        await prisma.$transaction([
          prisma.company.update({ where: { id: m.apprenticeId }, data: { balance: { increment: ap } } }),
          prisma.transaction.create({ data: { companyId: m.apprenticeId, type: "COMPAGNONNAGE", amount: ap, description: `Compagnonnage : grade ${gradeName(g)} atteint (tuteur ${mentor?.name ?? ""})` } }),
          prisma.company.update({ where: { id: m.mentorId }, data: { balance: { increment: mp } } }),
          prisma.transaction.create({ data: { companyId: m.mentorId, type: "COMPAGNONNAGE", amount: mp, description: `Compagnonnage : ${c.name} devient ${gradeName(g)}` } }),
        ]);
        await sendToCompany(m.mentorId, { title: "Votre apprenti progresse", body: `${c.name} devient ${gradeName(g)} : +${mp} pi. pour vous.`, url: "/dashboard", tag: "compagnonnage" }).catch(() => undefined);
        await sendToCompany(m.apprenticeId, { title: "Prime de compagnonnage", body: `Grade ${gradeName(g)} atteint : +${ap} pi.`, url: "/dashboard", tag: "compagnonnage" }).catch(() => undefined);
      }
      if (grade >= GRADUATE_GRADE) {
        await prisma.mentorship.updateMany({ where: { id: m.id, endedAt: null }, data: { endedAt: new Date(), endReason: "DIPLOME" } });
        continue;
      }
      const seen = c.lastActiveAt ?? c.createdAt;
      if (ageDays(seen) > INACTIVE_DAYS) {
        await prisma.mentorship.updateMany({ where: { id: m.id, endedAt: null }, data: { endedAt: new Date(), endReason: "INACTIF" } });
      }
    } catch (err) {
      console.error("[compagnonnage]", (err as Error).message);
    }
  }
}

let timer: NodeJS.Timeout | null = null;
export function startMentorJob() {
  if (timer) return;
  timer = setInterval(() => void checkMentorships().catch((e) => console.error("[compagnonnage]", (e as Error).message)), 10 * 60_000);
  setTimeout(() => void checkMentorships().catch(() => undefined), 60_000);
}
