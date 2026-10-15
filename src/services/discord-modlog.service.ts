import crypto from "crypto";
import { AuditLogEvent, Client, Guild, GuildMember, Message, PartialGuildMember, PartialMessage } from "discord.js";
import { prisma } from "../prisma";
import { botEnabled, channelId, Embed, rest } from "./discord.service";

/* ============================================================
   Journal de modération (2.1) : ce qui se passe sur le serveur, écrit
   dans #logs pour le staff.

   Arrivées et départs, exclusions, bannissements, mises en sourdine,
   messages supprimés ou modifiés, changements de pseudo, comptes liés.

   Le contenu des messages supprimés ou modifiés demande l'intent
   « Message Content » (portail développeur → Bot). Sans lui, le journal
   indique qu'un message a été supprimé, sans son texte.

   Pendant un déploiement, deux conteneurs écoutent quelques instants :
   chaque entrée est réservée dans DiscordPost avant l'envoi.
   ============================================================ */

const COLORS = {
  arrivee: 0x10b981,
  depart: 0x64748b,
  sanction: 0xef4444,
  avertissement: 0xf59e0b,
  message: 0xef4444,
  edition: 0x38bdf8,
  compte: 0xf2a900,
};

const ts = (ms: number, style: "R" | "f" = "R") => `<t:${Math.floor(ms / 1000)}:${style}>`;
const clip = (s: string, n = 1000) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const block = (s: string) => (s ? clip(s.replace(/```/g, "ʼʼʼ")) : "*(vide)*");

/* Écrit une entrée, une seule fois même si deux serveurs l'ont vue. */
async function log(key: string, embed: Embed) {
  if (!botEnabled()) return;
  try {
    await prisma.discordPost.create({ data: { key: `log:${key}`, channelId: "", messageId: "" } });
  } catch {
    return;
  }
  const channel = await channelId("LOGS");
  if (!channel) return;
  await rest("POST", `/channels/${channel}/messages`, {
    body: { embeds: [{ ...embed, timestamp: new Date().toISOString() }], allowed_mentions: { parse: [] } },
  });
}

/* Pour les événements venus du jeu (liaison de compte), appelés une seule fois. */
export async function logAccount(text: string, discordId: string) {
  await log(`compte:${discordId}:${Date.now()}`, { color: COLORS.compte, description: `🔗 <@${discordId}> ${text}` }).catch((err) =>
    console.error("[discord] journal :", (err as Error).message)
  );
}

/* Une ligne libre dans #logs : actions du staff (cadeaux, giveaways). */
export async function logStaff(text: string) {
  await log(`staff:${crypto.randomUUID()}`, { color: COLORS.compte, description: text }).catch((err) =>
    console.error("[discord] journal :", (err as Error).message)
  );
}

/* Qui a fait l'action, d'après le journal d'audit de Discord (dans les dix dernières secondes). */
async function auditFor(guild: Guild, type: AuditLogEvent, targetId: string) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    const entry = logs.entries.find((e) => (e.target as { id?: string } | null)?.id === targetId && Date.now() - e.createdTimestamp < 10_000);
    return entry ? { by: entry.executor?.id ?? null, reason: entry.reason ?? null } : null;
  } catch {
    return null;
  }
}

const who = (id: string | null | undefined) => (id ? `<@${id}>` : "inconnu");
const since = (ms: number | null | undefined) => {
  if (!ms) return "durée inconnue";
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  return d < 1 ? "moins d'un jour" : `${d} jour${d > 1 ? "s" : ""}`;
};

export function attachModLog(client: Client, guildId: string) {
  const onError = (what: string) => (err: unknown) => console.error(`[discord] journal (${what}) :`, (err as Error).message);

  client.on("guildMemberAdd", (m) => {
    if (m.guild.id !== guildId) return;
    const age = Date.now() - m.user.createdTimestamp;
    const fresh = age < 7 * 86_400_000;
    void log(`arrivee:${m.id}:${m.joinedTimestamp}`, {
      color: fresh ? COLORS.avertissement : COLORS.arrivee,
      author: { name: `${m.user.tag} est arrivé`, icon_url: m.user.displayAvatarURL({ size: 64 }) },
      description: `<@${m.id}> · ${m.guild.memberCount}e membre`,
      fields: [{ name: "Compte Discord créé", value: `${ts(m.user.createdTimestamp)}${fresh ? " ⚠️ compte récent" : ""}`, inline: true }],
      footer: { text: `ID ${m.id}` },
    }).catch(onError("arrivée"));
  });

  client.on("guildMemberRemove", (m: GuildMember | PartialGuildMember) => {
    if (m.guild.id !== guildId) return;
    void (async () => {
      const kick = await auditFor(m.guild, AuditLogEvent.MemberKick, m.id);
      const roles = m.roles?.cache.filter((r) => r.id !== m.guild.id).map((r) => r.name) ?? [];
      await log(`depart:${m.id}:${Math.floor(Date.now() / 15_000)}`, {
        color: kick ? COLORS.sanction : COLORS.depart,
        author: { name: `${m.user?.tag ?? m.id} ${kick ? "a été exclu" : "est parti"}`, icon_url: m.user?.displayAvatarURL({ size: 64 }) },
        description: `<@${m.id}> · resté ${since(m.joinedTimestamp)}`,
        fields: [
          ...(kick ? [{ name: "Exclu par", value: who(kick.by), inline: true }, { name: "Raison", value: kick.reason ?? "*non précisée*", inline: true }] : []),
          ...(roles.length ? [{ name: "Rôles", value: clip(roles.join(", "), 1000) }] : []),
        ],
        footer: { text: `ID ${m.id}` },
      });
    })().catch(onError("départ"));
  });

  client.on("guildBanAdd", (ban) => {
    if (ban.guild.id !== guildId) return;
    void (async () => {
      const a = await auditFor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
      await log(`ban:${ban.user.id}:${Math.floor(Date.now() / 15_000)}`, {
        color: COLORS.sanction,
        author: { name: `${ban.user.tag} a été banni`, icon_url: ban.user.displayAvatarURL({ size: 64 }) },
        description: `<@${ban.user.id}>`,
        fields: [
          { name: "Par", value: who(a?.by), inline: true },
          { name: "Raison", value: a?.reason ?? ban.reason ?? "*non précisée*", inline: true },
        ],
        footer: { text: `ID ${ban.user.id}` },
      });
    })().catch(onError("bannissement"));
  });

  client.on("guildBanRemove", (ban) => {
    if (ban.guild.id !== guildId) return;
    void (async () => {
      const a = await auditFor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
      await log(`deban:${ban.user.id}:${Math.floor(Date.now() / 15_000)}`, {
        color: COLORS.depart,
        description: `🔓 **${ban.user.tag}** (<@${ban.user.id}>) n'est plus banni · par ${who(a?.by)}`,
      });
    })().catch(onError("débannissement"));
  });

  client.on("guildMemberUpdate", (before, after) => {
    if (after.guild.id !== guildId) return;
    void (async () => {
      // mise en sourdine (exclusion temporaire)
      const was = before.communicationDisabledUntilTimestamp ?? 0;
      const now = after.communicationDisabledUntilTimestamp ?? 0;
      if (now !== was && (now > Date.now() || was > Date.now())) {
        const a = await auditFor(after.guild, AuditLogEvent.MemberUpdate, after.id);
        const on = now > Date.now();
        await log(`sourdine:${after.id}:${now}`, {
          color: on ? COLORS.avertissement : COLORS.depart,
          author: { name: `${after.user.tag} ${on ? "est en sourdine" : "n'est plus en sourdine"}`, icon_url: after.user.displayAvatarURL({ size: 64 }) },
          description: on ? `<@${after.id}> jusqu'à ${ts(now, "f")} (${ts(now)})` : `<@${after.id}>`,
          fields: [
            { name: "Par", value: who(a?.by), inline: true },
            ...(on ? [{ name: "Raison", value: a?.reason ?? "*non précisée*", inline: true }] : []),
          ],
        });
      }
      // changement de pseudo sur le serveur
      if (!before.partial && before.nickname !== after.nickname) {
        await log(`pseudo:${after.id}:${Math.floor(Date.now() / 5_000)}`, {
          color: COLORS.edition,
          description: `✏️ <@${after.id}> change de pseudo : **${before.nickname ?? before.user.username}** → **${after.nickname ?? after.user.username}**`,
        });
      }
    })().catch(onError("membre"));
  });

  client.on("messageDelete", (msg: Message | PartialMessage) => {
    if (!msg.guild || msg.guild.id !== guildId || msg.author?.bot) return;
    if (msg.channel && "name" in msg.channel && msg.channel.name === "📋・logs") return;
    void (async () => {
      const files = msg.attachments?.map((a) => a.name).filter(Boolean) ?? [];
      await log(`suppr:${msg.id}`, {
        color: COLORS.message,
        author: msg.author ? { name: `Message de ${msg.author.tag} supprimé`, icon_url: msg.author.displayAvatarURL({ size: 64 }) } : { name: "Message supprimé" },
        description: [
          `${msg.author ? `<@${msg.author.id}>` : "Auteur inconnu"} dans <#${msg.channelId}>`,
          "",
          msg.partial || msg.content === null
            ? "*Contenu indisponible : message envoyé avant le démarrage du bot, ou intent « Message Content » désactivé.*"
            : block(msg.content),
        ].join("\n"),
        fields: files.length ? [{ name: "Pièces jointes", value: clip(files.join(", "), 1000) }] : undefined,
        footer: { text: `Message ${msg.id}` },
      });
    })().catch(onError("suppression"));
  });

  client.on("messageUpdate", (before, after) => {
    if (!after.guild || after.guild.id !== guildId || after.author?.bot) return;
    // Discord renvoie aussi un « update » quand il ajoute un aperçu de lien : on ne garde que les vraies modifications
    if (before.partial || before.content === null || after.content === null || before.content === after.content) return;
    void log(`edit:${after.id}:${after.editedTimestamp ?? Date.now()}`, {
      color: COLORS.edition,
      author: after.author ? { name: `${after.author.tag} a modifié un message`, icon_url: after.author.displayAvatarURL({ size: 64 }) } : undefined,
      description: `<@${after.author?.id}> dans <#${after.channelId}> · [voir le message](${after.url})`,
      fields: [
        { name: "Avant", value: block(before.content) },
        { name: "Après", value: block(after.content) },
      ],
    }).catch(onError("modification"));
  });
}

/* Les réservations du journal et des bienvenues ne servent qu'à éviter les
   doublons pendant un déploiement : on les oublie au bout de deux jours. */
export async function pruneLogKeys() {
  await prisma.discordPost.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - 2 * 86_400_000) }, OR: [{ key: { startsWith: "log:" } }, { key: { startsWith: "bienvenue:" } }] },
  });
}
