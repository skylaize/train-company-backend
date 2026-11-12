import { prisma } from "../prisma";
import { QUIZ } from "../data/quiz";
import { botEnabled, BRAND_COLOR, channelId, DiscordError, Embed, esc, fmt, rest } from "./discord.service";
import { companyForDiscord } from "./gift.service";

/* ============================================================
   Quiz du jour (2.8).

   Chaque jour à 11 h (heure de Paris), une question tombe dans 🧠・quiz
   avec quatre boutons. Chacun répond une fois, en privé. Une bonne
   réponse rapporte des pièces à la compagnie du joueur, s'il a lié son
   compte. Le lendemain à 11 h, la réponse est dévoilée avec le score du
   serveur, et la question suivante arrive.

   Les questions passent toutes avant qu'une seule ne revienne (ordre
   mélangé une fois pour toutes, voir data/quiz.ts).
   ============================================================ */

export const QUIZ_REWARD = 100; // pièces par bonne réponse
/* Une série de bonnes réponses, jour après jour : tous les 7 jours d'affilée, un bonus. */
export const STREAK_DAYS = 7;
export const STREAK_BONUS = 500;
/* Le meilleur du mois (le plus de bonnes réponses) gagne l'emblème « Cerveau
   du rail », gardé pour toujours, et le rôle 🧠 Champion du quiz pendant le
   mois qui suit. En cas d'égalité, tous les premiers. */
export const QUIZ_EMBLEM = "cerveau";
const POST_HOUR = 11; // heure de Paris
const LETTERS = ["A", "B", "C", "D"];

function parisNow(now = new Date()) {
  const p = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/* Un générateur pseudo-aléatoire reproductible : même graine, même mélange. */
function shuffled<T>(items: T[], seed: number) {
  const out = [...items];
  let x = (seed * 2654435761 + 97) >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const ORDER = shuffled(QUIZ.map((_, i) => i), 2026);

/* Les quatre propositions dans l'ordre affiché ce jour-là, et la place de la bonne. */
function layout(questionIdx: number, day: string) {
  const q = QUIZ[questionIdx % QUIZ.length];
  const seed = Number(day.replace(/-/g, "")) + questionIdx;
  const order = shuffled([0, 1, 2, 3], seed);
  return { q, choices: order.map((i) => q.choices[i]), correct: order.indexOf(0) };
}

type QuizRow = { day: string; questionIdx: number; channelId: string; messageId: string; closedAt: Date | null };

function view(quiz: QuizRow, stats?: { total: number; right: number }) {
  const { q, choices, correct } = layout(quiz.questionIdx, quiz.day);
  const closed = Boolean(stats);
  const lines = choices.map((c, i) => `**${LETTERS[i]}.** ${esc(c)}${closed && i === correct ? " ✅" : ""}`);
  const embed: Embed = {
    title: "🧠 Quiz du jour",
    description: [`**${q.q}**`, "", ...lines].join("\n"),
    color: closed ? 0x64748b : BRAND_COLOR,
    footer: { text: closed ? "Quiz terminé" : `Une réponse par personne · bonne réponse : ${QUIZ_REWARD} pièces pour ta compagnie (compte lié)` },
  };
  if (stats) {
    const pct = stats.total ? Math.round((stats.right / stats.total) * 100) : 0;
    embed.fields = [
      { name: "La réponse", value: `**${LETTERS[correct]}. ${esc(choices[correct])}**\n${q.info}` },
      { name: "Le serveur", value: stats.total ? `${stats.total} participant${stats.total > 1 ? "s" : ""} · ${pct} % de bonnes réponses` : "Personne n'a répondu cette fois." },
    ];
  }
  return {
    embeds: [embed],
    components: [
      {
        type: 1,
        components: choices.map((_, i) => ({ type: 2, style: closed ? (i === correct ? 3 : 2) : 1, label: LETTERS[i], custom_id: `quiz:${quiz.day}:${i}`, disabled: closed })),
      },
    ],
    allowed_mentions: { parse: [] as string[] },
  };
}

async function closeQuiz(quiz: QuizRow) {
  const [total, right] = await Promise.all([
    prisma.discordQuizAnswer.count({ where: { day: quiz.day } }),
    prisma.discordQuizAnswer.count({ where: { day: quiz.day, correct: true } }),
  ]);
  // fermé en base d'abord : plus aucune réponse n'est acceptée, même si Discord tarde
  await prisma.discordQuiz.update({ where: { day: quiz.day }, data: { closedAt: new Date() } });
  if (!quiz.messageId) return;
  await rest("PATCH", `/channels/${quiz.channelId}/messages/${quiz.messageId}`, { body: view(quiz, { total, right }) }).catch((err) => {
    if (!(err instanceof DiscordError && err.status === 404)) throw err;
  });
}

/* Appelé toutes les cinq minutes par le fil d'annonces. */
export async function runQuiz(now = new Date()) {
  if (!botEnabled() || QUIZ.length === 0) return;
  const { day, hour } = parisNow(now);
  if (hour < POST_HOUR) return;

  const open = (await prisma.discordQuiz.findMany({ where: { closedAt: null, day: { lt: day } } })) as QuizRow[];
  for (const quiz of open) await closeQuiz(quiz);

  if (await prisma.discordQuiz.findUnique({ where: { day } })) return;
  const channel = await channelId("QUIZ");
  if (!channel) return;
  const played = await prisma.discordQuiz.count();
  const questionIdx = ORDER[played % ORDER.length];
  /* La ligne est créée AVANT d'envoyer : si deux conteneurs passent ici en
     même temps (déploiement), un seul gagne l'insertion. */
  let quiz: QuizRow;
  try {
    quiz = (await prisma.discordQuiz.create({ data: { day, questionIdx, channelId: channel } })) as QuizRow;
  } catch {
    return;
  }
  try {
    const msg = await rest<{ id: string }>("POST", `/channels/${channel}/messages`, { body: view(quiz) });
    await prisma.discordQuiz.update({ where: { day }, data: { messageId: msg!.id } });
  } catch (err) {
    await prisma.discordQuiz.delete({ where: { day } }).catch(() => undefined);
    throw err;
  }
}

/* La veille d'un jour AAAA-MM-JJ. */
function dayBefore(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/* La série en cours : jours consécutifs de bonnes réponses, jusqu'à ce jour compris. */
async function streakOf(discordId: string, day: string) {
  const rows = (await prisma.discordQuizAnswer.findMany({
    where: { discordId },
    orderBy: { day: "desc" },
    take: 60,
    select: { day: true, correct: true },
  })) as { day: string; correct: boolean }[];
  let n = 0;
  let expect = day;
  for (const r of rows) {
    if (r.day !== expect || !r.correct) break;
    n++;
    expect = dayBefore(expect);
  }
  return n;
}

/* ---------------- champion du mois ---------------- */

let champCache: { at: number; byMonth: Map<string, string[]> } | null = null;
/* Les premiers de chaque mois fini (heure de Paris), par mois AAAA-MM. */
export async function quizChampions() {
  if (champCache && Date.now() - champCache.at < 10 * 60_000) return champCache.byMonth;
  const rows = (await prisma.$queryRaw`
    SELECT substring("day" from 1 for 7) AS month, "discordId", COUNT(*)::int AS n
    FROM "DiscordQuizAnswer" WHERE "correct" = true
    GROUP BY 1, 2`) as { month: string; discordId: string; n: number }[];
  const current = parisNow().day.slice(0, 7);
  const best = new Map<string, { n: number; ids: string[] }>();
  for (const r of rows) {
    if (r.month >= current) continue; // le mois en cours n'est pas fini
    const b = best.get(r.month);
    if (!b || r.n > b.n) best.set(r.month, { n: r.n, ids: [r.discordId] });
    else if (r.n === b.n) b.ids.push(r.discordId);
  }
  champCache = { at: Date.now(), byMonth: new Map([...best].map(([m, b]) => [m, b.ids])) };
  return champCache.byMonth;
}

/* Le rôle : les premiers du mois précédent. */
export async function lastMonthChampions() {
  const byMonth = await quizChampions();
  const months = [...byMonth.keys()].sort();
  const current = parisNow().day.slice(0, 7);
  const [y, m] = current.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  return new Set<string>((months.includes(prev) ? byMonth.get(prev) : undefined) ?? []);
}

/* L'emblème : premier d'au moins un mois, pour toujours. */
export async function isQuizChampion(companyId: string) {
  const owner = (await prisma.company.findUnique({ where: { id: companyId }, select: { owner: { select: { discordId: true } } } })) as { owner: { discordId: string | null } } | null;
  const id = owner?.owner.discordId;
  if (!id) return false;
  for (const ids of (await quizChampions()).values()) if (ids.includes(id)) return true;
  return false;
}

/* Un clic sur A, B, C ou D. Renvoie le texte affiché au joueur seul. */
export async function answerQuiz(day: string, choice: number, discordId: string) {
  const quiz = (await prisma.discordQuiz.findUnique({ where: { day } })) as QuizRow | null;
  if (!quiz || quiz.closedAt) return "Ce quiz est terminé. Le prochain arrive à 11 h.";
  if (!discordId || !(choice >= 0 && choice < 4)) return "Réponse illisible, réessaie.";
  const { correct } = layout(quiz.questionIdx, quiz.day);
  const right = choice === correct;
  try {
    await prisma.discordQuizAnswer.create({ data: { day, discordId, choice, correct: right } });
  } catch {
    return "Tu as déjà répondu au quiz du jour. La réponse sera dévoilée demain à 11 h.";
  }
  if (!right) return `❌ Ce n'est pas **${LETTERS[choice]}**. La bonne réponse sera dévoilée demain à 11 h, avec une nouvelle question.`;

  const who = await companyForDiscord(discordId);
  if ("error" in who) {
    return `✅ Bonne réponse ! Lie ton compte Réseau (**/lier**) pour gagner ${QUIZ_REWARD} pièces à chaque bonne réponse.`;
  }
  // une série de 7, 14, 21… jours d'affilée : le bonus en plus
  const streak = await streakOf(discordId, day).catch(() => 0);
  const bonus = streak > 0 && streak % STREAK_DAYS === 0 ? STREAK_BONUS : 0;
  await prisma.$transaction([
    prisma.company.update({ where: { id: who.company.id }, data: { balance: { increment: QUIZ_REWARD + bonus } } }),
    prisma.transaction.create({ data: { companyId: who.company.id, type: "CADEAU", amount: QUIZ_REWARD, description: "Quiz du jour sur Discord : bonne réponse" } }),
    ...(bonus ? [prisma.transaction.create({ data: { companyId: who.company.id, type: "CADEAU", amount: bonus, description: `Quiz du jour sur Discord : ${streak} bonnes réponses d'affilée` } })] : []),
  ]);
  const serie = bonus
    ? `\n🔥 **${streak} jours d'affilée** : **+${STREAK_BONUS} pièces** de bonus !`
    : streak >= 2
      ? `\n🔥 Série : ${streak} jour${streak > 1 ? "s" : ""} d'affilée (bonus de ${STREAK_BONUS} pièces à ${Math.ceil(streak / STREAK_DAYS) * STREAK_DAYS}).`
      : "";
  return `✅ Bonne réponse ! **+${QUIZ_REWARD} pièces** pour **${esc(who.company.name)}**.${serie}\nReviens demain à 11 h pour la suivante.`;
}

/* /quiz : le score du joueur et le podium du mois. */
export async function quizReply(discordId: string): Promise<{ embeds: Embed[] }> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const month = new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: "Europe/Paris" }).format(now);
  const [top, mine, mineRight, everRight] = await Promise.all([
    prisma.discordQuizAnswer.groupBy({ by: ["discordId"], where: { correct: true, createdAt: { gte: monthStart } }, _count: { _all: true }, orderBy: { _count: { discordId: "desc" } }, take: 10 }),
    prisma.discordQuizAnswer.count({ where: { discordId, createdAt: { gte: monthStart } } }),
    prisma.discordQuizAnswer.count({ where: { discordId, correct: true, createdAt: { gte: monthStart } } }),
    prisma.discordQuizAnswer.count({ where: { discordId, correct: true } }),
  ]);
  const medal = (i: number) => ["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`;
  const rows = top as { discordId: string; _count: { _all: number } }[];
  return {
    embeds: [
      {
        title: `🧠 Quiz · ${month}`,
        color: BRAND_COLOR,
        description: rows.length ? rows.map((r, i) => `${medal(i)} <@${r.discordId}> · **${r._count._all}** bonne${r._count._all > 1 ? "s" : ""} réponse${r._count._all > 1 ? "s" : ""}`).join("\n") : "Personne n'a encore marqué ce mois-ci.",
        fields: [
          { name: "Toi, ce mois-ci", value: mine ? `${mineRight} bonne${mineRight > 1 ? "s" : ""} réponse${mineRight > 1 ? "s" : ""} sur ${mine}` : "Pas encore joué", inline: true },
          { name: "Depuis le début", value: `${fmt(everRight)} bonne${everRight > 1 ? "s" : ""} réponse${everRight > 1 ? "s" : ""}`, inline: true },
        ],
        footer: { text: `Une question par jour à 11 h dans 🧠・quiz · ${STREAK_DAYS} bonnes réponses d'affilée : +${STREAK_BONUS} pièces · le premier du mois gagne l'emblème « Cerveau du rail » et le rôle 🧠 Champion du quiz` },
      },
    ],
  };
}
