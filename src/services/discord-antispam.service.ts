import { Client, Events, Message, PermissionFlagsBits } from "discord.js";
import { prisma } from "../prisma";
import { logStaff } from "./discord-modlog.service";

/* ============================================================
   Anti-spam (2.8).

   Le bot retire tout seul ce qui ressemble à une arnaque ou à un compte
   piraté, met l'auteur en sourdine et prévient le staff dans #logs :

   - arnaques connues (« nitro gratuit », cadeaux Steam, crypto…) avec un
     lien, ou un @everyone tenté avec un lien : supprimé, sourdine 12 h ;
   - le même message collé dans trois salons en une minute (la signature
     d'un compte piraté) : tout est supprimé, sourdine 12 h ;
   - rafale (six messages en huit secondes) ou six mentions d'un coup :
     supprimé, sourdine 10 minutes ;
   - invitation vers un autre serveur Discord par un membre arrivé depuis
     moins de trois jours : supprimée (permis dans les salons d'alliance) ;
   - lien posté par un compte Discord créé depuis moins de 24 h : supprimé.

   Le staff (permission « Gérer les messages ») et les bots ne sont jamais
   concernés. Sans l'intent « Message Content », seules les règles de
   rafale et de mentions fonctionnent.
   ============================================================ */

const MIN = 60_000;
const TIMEOUT_SCAM = 12 * 60 * MIN;
const TIMEOUT_FLOOD = 10 * MIN;
const NEW_MEMBER_MS = 3 * 24 * 60 * MIN;
const NEW_ACCOUNT_MS = 24 * 60 * MIN;

const LINK = /https?:\/\/|www\.\S+\.\S+/i;
const INVITE = /(?:discord\.gg|discord(?:app)?\.com\/invite|discord\.me|dsc\.gg)\/([\w-]+)/i;
const SCAM = /free\s*nitro|nitro\s*(gratuit|free|offert)|steam\s*(gift|cadeau)|gift\s*card|airdrop|crypto\s*(giveaway|bonus)|(btc|eth|usdt)\s*(giveaway|bonus|x2)|casino\s*bonus|onlyfans|leaked?\s*nudes|\bnudes?\b.*https?:|t\.me\/|telegram\.me\//i;
const EVERYONE = /@everyone|@here/;

type Seen = { at: number; channel: string; id: string; text: string };
const recent = new Map<string, Seen[]>();

function remember(m: Message) {
  const now = Date.now();
  const list = (recent.get(m.author.id) ?? []).filter((s) => now - s.at < MIN);
  list.push({ at: now, channel: m.channelId, id: m.id, text: m.content.trim().toLowerCase() });
  recent.set(m.author.id, list);
  // un peu de ménage, pour que la mémoire ne grossisse pas
  if (recent.size > 2000) for (const [k, v] of recent) if (!v.some((s) => now - s.at < MIN)) recent.delete(k);
  return list;
}

type Verdict = { reason: string; timeout: number; extra?: Seen[] };

async function judge(m: Message, guildId: string): Promise<Verdict | null> {
  const text = m.content ?? "";
  const list = remember(m);
  const now = Date.now();
  const hasLink = LINK.test(text);

  if (hasLink && SCAM.test(text)) return { reason: "arnaque probable (mots-clés et lien)", timeout: TIMEOUT_SCAM };
  if (hasLink && EVERYONE.test(text)) return { reason: "@everyone avec un lien", timeout: TIMEOUT_SCAM };

  // le même texte dans trois salons en une minute
  const norm = text.trim().toLowerCase();
  if (norm.length >= 12 || hasLink) {
    const same = list.filter((s) => s.text === norm);
    if (new Set(same.map((s) => s.channel)).size >= 3) return { reason: "même message collé dans plusieurs salons", timeout: TIMEOUT_SCAM, extra: same };
  }

  if (list.filter((s) => now - s.at < 8000).length >= 6) return { reason: "rafale de messages", timeout: TIMEOUT_FLOOD, extra: list.filter((s) => now - s.at < 8000) };
  if (m.mentions.users.size >= 6) return { reason: "mentions en masse", timeout: TIMEOUT_FLOOD };

  const invite = INVITE.exec(text);
  if (invite && m.member?.joinedTimestamp && now - m.member.joinedTimestamp < NEW_MEMBER_MS) {
    const parent = "parent" in m.channel ? m.channel.parent : null;
    const inAlliances = /alliance/i.test(("name" in m.channel ? m.channel.name : "") ?? "") || /alliance/i.test(parent?.name ?? "") || /alliance/i.test((parent && "parent" in parent ? parent.parent?.name : "") ?? "");
    if (!inAlliances) {
      // une invitation vers CE serveur est toujours permise
      const target = await m.client.fetchInvite(invite[1]).catch(() => null);
      if (target?.guild?.id !== guildId) return { reason: "invitation vers un autre serveur (membre arrivé depuis moins de 3 jours)", timeout: 0 };
    }
  }

  if (hasLink && now - m.author.createdTimestamp < NEW_ACCOUNT_MS) return { reason: "lien posté par un compte Discord créé depuis moins de 24 h", timeout: 0 };
  return null;
}

const dur = (ms: number) => (ms >= 60 * MIN ? `${Math.round(ms / (60 * MIN))} h` : `${Math.round(ms / MIN)} min`);

async function act(m: Message, v: Verdict) {
  // réservé en base : pendant un déploiement, un seul des deux conteneurs agit
  try {
    await prisma.discordPost.create({ data: { key: `log:spam:${m.id}`, channelId: m.channelId, messageId: m.id } });
  } catch {
    return;
  }
  await m.delete().catch(() => undefined);
  for (const s of v.extra ?? []) {
    if (s.id === m.id) continue;
    const ch = m.guild?.channels.cache.get(s.channel);
    if (ch?.isTextBased()) await ch.messages.delete(s.id).catch(() => undefined);
  }
  recent.delete(m.author.id);
  let muted = false;
  if (v.timeout && m.member?.moderatable) {
    muted = await m.member.timeout(v.timeout, `Anti-spam : ${v.reason}`).then(() => true).catch(() => false);
  }
  if (!v.timeout && m.channel.isSendable()) {
    // simple retrait : un mot d'explication, effacé au bout de quinze secondes
    const note = await m.channel.send({ content: `<@${m.author.id}>, ton message a été retiré : ${v.reason}. Si c'est une erreur, demande au staff.`, allowedMentions: { users: [m.author.id] } }).catch(() => null);
    if (note) setTimeout(() => void note.delete().catch(() => undefined), 15_000).unref();
  }
  const excerpt = m.content ? `\n\`\`\`${m.content.replace(/```/g, "ʼʼʼ").slice(0, 600)}\`\`\`` : "";
  await logStaff(`🛡️ **Anti-spam** · message de <@${m.author.id}> retiré dans <#${m.channelId}> · ${v.reason}${muted ? ` · sourdine ${dur(v.timeout)}` : v.timeout ? " · sourdine impossible (rôle du bot trop bas ?)" : ""}${excerpt}`);
}

export function attachAntiSpam(client: Client, guildId: string) {
  client.on(Events.MessageCreate, (m) => {
    if (m.guildId !== guildId || m.author.bot || m.webhookId || m.system) return;
    if (m.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;
    void (async () => {
      const verdict = await judge(m, guildId);
      if (verdict) await act(m, verdict);
    })().catch((err) => console.error("[discord] anti-spam :", (err as Error).message));
  });
}
