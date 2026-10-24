import { ActivityType, Client, Events, GatewayIntentBits, Guild, GuildMember, Options, Partials } from "discord.js";
import { attachModLog, logArrival } from "./discord-modlog.service";
import { prisma } from "../prisma";
import { BOT_TOKEN, botEnabled, BRAND_COLOR, channelId, CHANNELS, esc, GUILD_ID, managedRoleIds, NOTIFY_ROLES, ROLES } from "./discord.service";
import { syncUser } from "./discord-roles.service";
import { recordBoost } from "./boost.service";

/* ============================================================
   Connexion permanente au Gateway de Discord (2.1).

   Le reste de l'intégration passe par l'API REST ; ce module ne sert qu'à
   ce qui demande d'écouter Discord en direct :
   - souhaiter la bienvenue à chaque nouveau membre, dans #général ;
   - afficher le bot « en ligne », avec le nombre de compagnies en statut.

   Demande l'intent privilégié « Server Members » : portail développeur →
   Bot → Privileged Gateway Intents → Server Members Intent. Sans lui la
   connexion est refusée ; on le signale et le reste continue de marcher.

   Pendant un déploiement, deux conteneurs sont connectés quelques instants :
   le message de bienvenue est réservé dans DiscordPost avant l'envoi, un
   seul des deux le publie.
   ============================================================ */

const WELCOME_CHANNEL = "💬・général";
const SITE_URL = (process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");

let client: Client | null = null;

async function companyCount() {
  return prisma.company.count();
}

async function setPresence() {
  if (!client?.user) return;
  const n = await companyCount().catch(() => null);
  client.user.setPresence({
    status: "online",
    activities: [{ type: ActivityType.Watching, name: n ? `${n} compagnies sur le réseau` : "le réseau ferré" }],
  });
}

/* Le message de bienvenue, façon MEE6. Si le nouveau venu arrive par le
   bouton « Lier mon Discord » du jeu, on connaît déjà sa compagnie. */
async function welcome(member: GuildMember) {
  if (member.user.bot) return;
  const key = `bienvenue:${member.id}:${member.joinedTimestamp ?? Date.now()}`;
  try {
    await prisma.discordPost.create({ data: { key, channelId: "", messageId: "" } });
  } catch {
    return; // déjà accueilli par l'autre conteneur
  }

  const channel = member.guild.channels.cache.find((c) => c.name === WELCOME_CHANNEL);
  if (!channel?.isTextBased()) return;

  const user = await prisma.user.findUnique({
    where: { discordId: member.id },
    select: { id: true, company: { select: { name: true } } },
  });
  const company = user?.company?.name;
  const find = (name: string) => member.guild.channels.cache.find((c) => c.name === name);
  const ref = (name: string) => (find(name) ? `<#${find(name)!.id}>` : `#${name}`);

  const lines = company
    ? [
        `La compagnie **${esc(company)}** entre en gare ! Ton compte est déjà lié, tes rôles arrivent dans un instant.`,
        "",
        `🗺️ Montre ton réseau dans ${ref("🗺️・mon-réseau")}`,
        `🤝 Trouve des alliés dans ${ref("🤝・alliances")}`,
      ]
    : [
        "Un nouveau voyageur sur le quai ! 🚉",
        "",
        `📜 Jette un œil au ${ref("📜・règlement")}`,
        `🚂 Pas encore de compagnie ? [Fonde la tienne](${SITE_URL || "https://compagnie.skhost.fr"}), c'est gratuit`,
        "🔗 Déjà joueur ? Lie ton compte dans le jeu (Paramètres → *Lier mon Discord*) pour recevoir tes rôles",
        `❓ Une question ? ${ref("❓・aide")}`,
      ];

  await channel.send({
    content: `Bienvenue <@${member.id}> !`,
    embeds: [
      {
        color: BRAND_COLOR,
        author: { name: `${member.displayName} vient d'arriver`, icon_url: member.displayAvatarURL({ size: 64 }) },
        description: lines.join("\n"),
        thumbnail: { url: member.displayAvatarURL({ size: 256 }) },
        footer: { text: `Tu es le ${member.guild.memberCount}e membre du serveur` },
      },
    ],
    allowedMentions: { users: [member.id] },
  });
  await prisma.discordPost.update({ where: { key }, data: { channelId: channel.id } }).catch(() => undefined);

  // compte déjà lié : rôles tout de suite, sans attendre les cinq minutes
  if (user) void syncUser(user.id).catch(() => undefined);
}

/* Au démarrage : les membres arrivés pendant que le bot était hors ligne
   (redémarrage, déploiement, panne) reçoivent leur bienvenue avec un peu de
   retard. Les arrivées déjà accueillies sont reconnues et sautées. */
const CATCH_UP_MS = 12 * 3_600_000;
async function catchUpArrivals(guild: Guild) {
  if (!client?.options.intents.has(GatewayIntentBits.GuildMembers)) return;
  const members = await guild.members.fetch();
  const missed = [...members.values()]
    .filter((m) => !m.user.bot && m.joinedTimestamp && Date.now() - m.joinedTimestamp < CATCH_UP_MS)
    .sort((a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0));
  let n = 0;
  for (const m of missed) {
    if (await prisma.discordPost.findUnique({ where: { key: `bienvenue:${m.id}:${m.joinedTimestamp}` } })) continue;
    await welcome(m);
    await logArrival(m, true);
    n++;
  }
  if (n) console.log(`[discord] ${n} arrivée(s) manquée(s) pendant l'arrêt du bot, accueillie(s) maintenant`);
}

/* Au démarrage : ce que le bot trouve sur le serveur, en clair dans les
   journaux de Coolify. C'est là qu'il faut regarder si rien ne s'affiche. */
async function diagnose() {
  const lines: string[] = [];
  try {
    await prisma.discordPost.count();
  } catch {
    lines.push("table DiscordPost absente : la migration 20261014100000_v2_1_discord n'a pas été jouée (npm run deploy:migrations)");
  }
  for (const [key, name] of Object.entries(CHANNELS)) {
    if (!(await channelId(key as keyof typeof CHANNELS).catch(() => null))) lines.push(`salon « ${name} » introuvable`);
  }
  const roles = await managedRoleIds().catch(() => new Map());
  for (const [key, name] of Object.entries(ROLES)) if (!roles.has(key as keyof typeof ROLES)) lines.push(`rôle « ${name} » introuvable`);
  const guild = client?.guilds.cache.get(GUILD_ID);
  if (guild) {
    for (const name of Object.values(NOTIFY_ROLES)) if (!guild.roles.cache.some((r) => r.name === name)) lines.push(`rôle « ${name} » introuvable`);
    const me = guild.members.me;
    const managed = guild.roles.cache.filter((r) => (Object.values(ROLES) as string[]).includes(r.name));
    const tooHigh = managed.filter((r) => me && r.position >= me.roles.highest.position);
    if (tooHigh.size) lines.push(`le rôle du bot doit être AU-DESSUS de : ${tooHigh.map((r) => r.name).join(", ")}`);
  }
  if (lines.length) for (const l of lines) console.warn(`[discord] ⚠️  ${l}`);
  else console.log("[discord] diagnostic : salons, rôles et base de données OK");
}

/* Les intents demandés, du plus complet au plus réduit : si un intent
   privilégié n'est pas activé dans le portail, on retente sans lui plutôt
   que de tout perdre. */
const INTENT_SETS: { intents: GatewayIntentBits[]; missing: string | null }[] = [
  {
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    missing: null,
  },
  {
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages],
    missing: "« Message Content Intent » : le journal ne montrera pas le texte des messages supprimés ou modifiés",
  },
  {
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages],
    missing: "« Server Members Intent » et « Message Content Intent » : pas de bienvenue ni d'arrivées/départs dans le journal",
  },
];

export function startDiscordGateway(level = 0) {
  if (!botEnabled() || client) return;
  const set = INTENT_SETS[level];
  client = new Client({
    intents: set.intents,
    // un message supprimé qui n'est pas en mémoire arrive quand même, sans son texte
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],
    // de quoi retrouver le texte des messages récents, sans laisser grossir la mémoire
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 100 }),
  });

  client.once(Events.ClientReady, async (c) => {
    const guild = c.guilds.cache.get(GUILD_ID);
    console.log(`[discord] connecté en tant que ${c.user.tag}${guild ? ` sur « ${guild.name} »` : " — ATTENTION : le bot n'est pas sur le serveur DISCORD_GUILD_ID"}`);
    if (set.missing) console.warn(`[discord] ⚠️  à activer dans le portail développeur → Bot → Privileged Gateway Intents : ${set.missing}`);
    await setPresence();
    setInterval(() => void setPresence(), 10 * 60_000).unref();
    await diagnose();
    if (guild) await catchUpArrivals(guild).catch((err) => console.error("[discord] rattrapage des arrivées :", (err as Error).message));
  });

  client.on(Events.GuildMemberAdd, (member) => {
    if (member.guild.id !== GUILD_ID) return;
    welcome(member).catch((err) => console.error("[discord] bienvenue :", (err as Error).message));
  });
  // 2.3 : un boost qui commence ou s'arrête, tout de suite (le passage des rôles rattrape le reste)
  client.on(Events.GuildMemberUpdate, (before, after) => {
    if (after.guild.id !== GUILD_ID) return;
    const was = before.partial ? undefined : before.premiumSinceTimestamp ?? null;
    const now = after.premiumSinceTimestamp ?? null;
    if (was === now) return;
    recordBoost(after.id, now ? new Date(now) : null).catch((err) => console.error("[discord] boost :", (err as Error).message));
  });
  client.on(Events.GuildMemberRemove, (member) => {
    if (member.guild.id !== GUILD_ID) return;
    recordBoost(member.id, null).catch(() => undefined);
  });
  attachModLog(client, GUILD_ID);

  client.on(Events.Error, (err) => console.error("[discord] gateway :", err.message));

  client.login(BOT_TOKEN).catch((err: Error) => {
    client?.destroy().catch(() => undefined);
    client = null;
    if (/disallowed intents/i.test(err.message) && level + 1 < INTENT_SETS.length) {
      startDiscordGateway(level + 1);
      return;
    }
    console.error("[discord] connexion au gateway impossible :", err.message);
  });
}
