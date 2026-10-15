import crypto from "crypto";
import { prisma } from "../prisma";
import { BRAND_COLOR, botEnabled, DiscordError, rest } from "./discord.service";
import { companyForDiscord, grantPrize, Prize, prizeLabel } from "./gift.service";
import { logStaff } from "./discord-modlog.service";

/* ============================================================
   Giveaways (2.1).

   /giveaway lancer → le bot poste l'annonce avec un bouton « Participer ».
   Seuls les comptes Réseau liés, avec une compagnie fondée, peuvent
   participer : pas de comptes jetables, et on sait à qui livrer le lot.
   Recliquer retire la participation.

   À l'échéance (vérifiée à chaque tour de simulation), le bot tire au
   sort, livre les lots dans le jeu, annonce les gagnants et ferme le
   bouton. Un gagnant qui a délié son compte, ou qui possède déjà l'objet,
   est remplacé par le suivant.
   ============================================================ */

type GiveawayRow = {
  id: string; channelId: string; messageId: string; prizeKind: string; prizeValue: string;
  winners: number; endsAt: Date; endedAt: Date | null; createdBy: string; winnerIds: string[];
};

export const MIN_DURATION_MS = 5 * 60_000;
export const MAX_DURATION_MS = 30 * 86_400_000;
export const MAX_WINNERS = 20;

/* « 48h », « 2j », « 1j12h », « 30m », « 1 semaine » → millisecondes. */
export function parseDuration(raw: string | undefined): number | null {
  const s = String(raw ?? "").toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  const units: Record<string, number> = { semaine: 7 * 86_400_000, semaines: 7 * 86_400_000, j: 86_400_000, jour: 86_400_000, jours: 86_400_000, d: 86_400_000, h: 3_600_000, heure: 3_600_000, heures: 3_600_000, m: 60_000, min: 60_000, minutes: 60_000 };
  let total = 0;
  let rest = s;
  const re = /^(\d+)(semaines?|jours?|heures?|minutes|min|j|d|h|m)/;
  while (rest) {
    const m = re.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * units[m[2]];
    rest = rest.slice(m[0].length);
  }
  return total > 0 ? total : null;
}

const prizeOf = (g: Pick<GiveawayRow, "prizeKind" | "prizeValue">): Prize =>
  g.prizeKind === "pieces" ? { kind: "pieces", amount: Number(g.prizeValue) } : { kind: "objet", itemId: g.prizeValue };

const ts = (d: Date, style = "R") => `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;

/* Le message du giveaway, ouvert ou terminé. */
function view(g: GiveawayRow, participants: number) {
  const open = !g.endedAt;
  const lines = [
    `**Lot :** ${prizeLabel(prizeOf(g))}${g.winners > 1 ? ` · **${g.winners} gagnants**` : ""}`,
    open ? `**Fin :** ${ts(g.endsAt)} (${ts(g.endsAt, "f")})` : `**Terminé** ${ts(g.endedAt!)}`,
    `**Participants :** ${participants}`,
    "",
  ];
  if (open) {
    lines.push("Clique sur **Participer** ! Il faut avoir lié ton compte Réseau (Paramètres → *Lier mon Discord*) et fondé ta compagnie. Le lot est livré directement dans le jeu.");
  } else {
    lines.push(g.winnerIds.length ? `🏆 ${g.winnerIds.length > 1 ? "Gagnants" : "Gagnant"} : ${g.winnerIds.map((id) => `<@${id}>`).join(", ")}` : "Aucun participant valable, pas de gagnant.");
  }
  return {
    embeds: [
      {
        title: open ? "🎉 Giveaway" : "🎉 Giveaway terminé",
        description: lines.join("\n"),
        color: open ? BRAND_COLOR : 0x64748b,
        footer: { text: `Lancé par l'équipe · ${g.id.slice(0, 8)}` },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: open ? 1 : 2, label: open ? "Participer" : "Terminé", emoji: { name: "🎉" }, custom_id: `giveaway:${g.id}`, disabled: !open },
        ],
      },
    ],
    allowed_mentions: { parse: [] as string[] },
  };
}

const count = (giveawayId: string) => prisma.giveawayEntry.count({ where: { giveawayId } });

async function refreshMessage(g: GiveawayRow) {
  if (!g.messageId) return;
  await rest("PATCH", `/channels/${g.channelId}/messages/${g.messageId}`, { body: view(g, await count(g.id)) }).catch((err) => {
    if (!(err instanceof DiscordError && err.status === 404)) throw err;
  });
}

/* ---------------- lancer ---------------- */

export async function createGiveaway(input: { channelId: string; prize: Prize; winners: number; durationMs: number; createdBy: string }) {
  const g = (await prisma.giveaway.create({
    data: {
      channelId: input.channelId,
      prizeKind: input.prize.kind,
      prizeValue: input.prize.kind === "pieces" ? String(input.prize.amount) : input.prize.itemId,
      winners: input.winners,
      endsAt: new Date(Date.now() + input.durationMs),
      createdBy: input.createdBy,
    },
  })) as GiveawayRow;
  try {
    const msg = await rest<{ id: string }>("POST", `/channels/${input.channelId}/messages`, { body: view(g, 0) });
    await prisma.giveaway.update({ where: { id: g.id }, data: { messageId: msg!.id } });
    g.messageId = msg!.id;
  } catch (err) {
    await prisma.giveaway.delete({ where: { id: g.id } }).catch(() => undefined);
    throw err;
  }
  void logStaff(`🎉 <@${input.createdBy}> lance un giveaway dans <#${input.channelId}> : ${prizeLabel(input.prize)}, ${input.winners} gagnant${input.winners > 1 ? "s" : ""}, fin ${ts(g.endsAt)}`);
  return g;
}

/* ---------------- participer (bouton) ---------------- */

const lastRefresh = new Map<string, number>();

export async function toggleEntry(giveawayId: string, discordId: string): Promise<string> {
  const g = (await prisma.giveaway.findUnique({ where: { id: giveawayId } })) as GiveawayRow | null;
  if (!g) return "Ce giveaway n'existe plus.";
  if (g.endedAt || g.endsAt <= new Date()) return "Ce giveaway est terminé.";

  const existing = await prisma.giveawayEntry.findUnique({ where: { giveawayId_discordId: { giveawayId, discordId } } });
  if (existing) {
    await prisma.giveawayEntry.delete({ where: { id: existing.id } });
    return "Tu ne participes plus à ce giveaway. Reclique sur **Participer** pour revenir.";
  }
  const who = await companyForDiscord(discordId);
  if ("error" in who) {
    return who.error.startsWith("n'a pas lié")
      ? "Pour participer, lie d'abord ton compte Réseau : dans le jeu, **Paramètres → Lier mon Discord**. Puis reclique sur **Participer**."
      : "Pour participer, fonde d'abord ta compagnie dans le jeu, puis reclique sur **Participer**.";
  }
  await prisma.giveawayEntry.create({ data: { giveawayId, discordId } }).catch(() => undefined);

  // le compteur du message, sans dépasser une mise à jour toutes les 10 secondes
  if (Date.now() - (lastRefresh.get(g.id) ?? 0) > 10_000) {
    lastRefresh.set(g.id, Date.now());
    void refreshMessage(g).catch(() => undefined);
  }
  return `C'est noté, tu participes avec **${who.company.name}** ! Tirage ${ts(g.endsAt)}. Bonne chance 🍀`;
}

/* ---------------- tirage ---------------- */

/* Tire `n` gagnants parmi les participants, en sautant ceux qui ne peuvent
   plus recevoir le lot, et le leur livre. */
async function draw(g: GiveawayRow, n: number, exclude: Set<string>) {
  const entries = ((await prisma.giveawayEntry.findMany({ where: { giveawayId: g.id }, select: { discordId: true } })) as { discordId: string }[])
    .map((e) => e.discordId)
    .filter((id) => !exclude.has(id));
  // mélange de Fisher-Yates, avec un hasard cryptographique
  for (let i = entries.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  const won: string[] = [];
  for (const discordId of entries) {
    if (won.length >= n) break;
    const who = await companyForDiscord(discordId);
    if ("error" in who) continue;
    const res = await grantPrize(who.company.id, prizeOf(g), "giveaway Discord");
    if (res.ok) won.push(discordId);
  }
  return won;
}

async function announce(g: GiveawayRow, won: string[], reroll = false) {
  const label = prizeLabel(prizeOf(g));
  const content = won.length
    ? `🎉 ${reroll ? "Nouveau tirage : f" : "F"}élicitations ${won.map((id) => `<@${id}>`).join(", ")} ! ${won.length > 1 ? "Vous remportez" : "Tu remportes"} **${label}**, déjà livré dans le jeu.`
    : reroll
      ? "Plus aucun participant valable pour un nouveau tirage."
      : "Le giveaway est terminé, mais aucun participant valable : pas de gagnant cette fois.";
  await rest("POST", `/channels/${g.channelId}/messages`, {
    body: {
      content,
      allowed_mentions: { users: won },
      ...(g.messageId ? { message_reference: { message_id: g.messageId, fail_if_not_exists: false } } : {}),
    },
  });
  void logStaff(`🎉 Giveaway ${g.id.slice(0, 8)} (${label}) : ${won.length ? won.map((id) => `<@${id}>`).join(", ") : "aucun gagnant"}${reroll ? " (nouveau tirage)" : ""}`);
}

/* Clôt un giveaway : un seul serveur gagne la clôture, même si deux passent ici. */
export async function finishGiveaway(id: string) {
  const claimed = await prisma.giveaway.updateMany({ where: { id, endedAt: null }, data: { endedAt: new Date() } });
  if (!claimed.count) return false;
  const g = (await prisma.giveaway.findUnique({ where: { id } })) as GiveawayRow;
  const won = await draw(g, g.winners, new Set());
  g.winnerIds = won;
  await prisma.giveaway.update({ where: { id }, data: { winnerIds: won } });
  await refreshMessage(g).catch((err) => console.error("[giveaway] message :", (err as Error).message));
  await announce(g, won);
  return true;
}

/* Un gagnant de plus (absent, injoignable…), parmi ceux qui n'ont pas encore gagné. */
export async function rerollGiveaway(id: string) {
  const g = (await prisma.giveaway.findUnique({ where: { id } })) as GiveawayRow | null;
  if (!g) return "Giveaway introuvable.";
  if (!g.endedAt) return "Ce giveaway n'est pas encore terminé : utilise « terminer » d'abord.";
  const won = await draw(g, 1, new Set(g.winnerIds));
  if (won.length) {
    g.winnerIds = [...g.winnerIds, ...won];
    await prisma.giveaway.update({ where: { id }, data: { winnerIds: g.winnerIds } });
    await refreshMessage(g).catch(() => undefined);
  }
  await announce(g, won, true);
  return won.length ? `Nouveau gagnant : <@${won[0]}>.` : "Plus aucun participant valable.";
}

/* Retrouve un giveaway par son identifiant court (pied du message), son
   identifiant complet, ou l'identifiant / le lien du message Discord. */
export async function findGiveaway(ref: string | undefined) {
  const s = String(ref ?? "").trim();
  if (!s) {
    return (await prisma.giveaway.findFirst({ orderBy: { createdAt: "desc" } })) as GiveawayRow | null;
  }
  const messageId = /(\d{15,})\s*$/.exec(s)?.[1];
  if (messageId) {
    const byMsg = await prisma.giveaway.findFirst({ where: { messageId } });
    if (byMsg) return byMsg as GiveawayRow;
  }
  return (await prisma.giveaway.findFirst({ where: { id: { startsWith: s.toLowerCase() } } })) as GiveawayRow | null;
}

/* ---------------- à chaque tour de simulation ---------------- */

const shownCount = new Map<string, number>();

export async function runGiveaways() {
  if (!botEnabled()) return;
  const open = (await prisma.giveaway.findMany({ where: { endedAt: null } })) as GiveawayRow[];
  for (const g of open) {
    try {
      if (g.endsAt <= new Date()) {
        await finishGiveaway(g.id);
        shownCount.delete(g.id);
        continue;
      }
      // compteur de participants tenu à jour, seulement s'il a bougé
      const n = await count(g.id);
      if (shownCount.get(g.id) !== n) {
        shownCount.set(g.id, n);
        await refreshMessage(g);
      }
    } catch (err) {
      console.error("[giveaway]", g.id.slice(0, 8), ":", (err as Error).message);
    }
  }
}
