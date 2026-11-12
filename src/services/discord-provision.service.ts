import { APP_ID, botEnabled, CHANNELS, ROLES, DiscordError, forgetGuildCache, ForumTag, GUILD_ID, GuildChannel, guildChannels, guildRoleList, rest } from "./discord.service";

/* ============================================================
   Ce que le bot installe lui-même sur le serveur (2.8).

   Au démarrage, il crée ce qui manque, sans jamais toucher à ce qui
   existe déjà (comparaison par nom) :
   - les quatre rôles de division de saison ;
   - le salon 🧠・quiz (lecture seule) ;
   - le forum 🎨・suggestions-graphiste dans la catégorie SUPPORT, où le
     rôle Graphiste peut gérer les posts ;
   - les étiquettes de suivi des forums de suggestions et de bugs.

   Il lui faut les permissions « Gérer les rôles » et « Gérer les salons »
   (ou Administrateur). S'il ne les a pas, c'est écrit dans les journaux
   et le reste du jeu continue comme avant.
   ============================================================ */

export const P = {
  ADD_REACTIONS: 1n << 6n,
  VIEW: 1n << 10n,
  SEND: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED: 1n << 14n,
  ATTACH: 1n << 15n,
  HISTORY: 1n << 16n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_THREADS: 1n << 35n,
  SEND_IN_THREADS: 1n << 38n,
};
const bits = (...p: bigint[]) => String(p.reduce((a, b) => a | b, 0n));

export const TYPE = { TEXT: 0, CATEGORY: 4, FORUM: 15 };

/* Rôles de division : même ordre que DIVISIONS dans saison.service. */
export const DIVISION_ROLES = [
  { name: "🥉 Division Bronze", color: 0xb0703c },
  { name: "🥈 Division Argent", color: 0xa8b3bd },
  { name: "🥇 Division Or", color: 0xe0b100 },
  { name: "💠 Division Platine", color: 0x6fd3e8 },
];

/* Étiquettes de suivi, par forum. Les noms sont ceux déjà posés par le
   script de mise en place ; « À l'étude » est ajoutée. */
export type ForumKind = "SUGGESTIONS" | "BUGS" | "GRAPHISTE";
export type Status = "nouveau" | "etude" | "accepte" | "prevu" | "fait" | "refuse";
const IDEA_TAGS: Record<Status, string> = { nouveau: "Idée", etude: "À l'étude", accepte: "Acceptée", prevu: "Prévue", fait: "Ajoutée", refuse: "Refusée" };
export const STATUS_TAGS: Record<ForumKind, Record<Status, string>> = {
  SUGGESTIONS: IDEA_TAGS,
  GRAPHISTE: IDEA_TAGS,
  BUGS: { nouveau: "Nouveau", etude: "Confirmé", accepte: "Confirmé", prevu: "En cours", fait: "Corrigé", refuse: "Pas un bug" },
};
export const FORUM_KINDS: ForumKind[] = ["SUGGESTIONS", "BUGS", "GRAPHISTE"];

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const warn = (msg: string) => console.warn(`[discord] ⚠️  ${msg}`);

/* Le rôle du graphiste : n'importe quel rôle dont le nom contient « graphiste ». */
export async function graphisteRoleId() {
  return (await guildRoleList()).find((r) => norm(r.name).includes("graphist"))?.id ?? null;
}

async function ensureDivisionRoles() {
  const roles = await guildRoleList(true);
  for (const d of [...DIVISION_ROLES, { name: ROLES.QUIZ, color: 0xc084fc }]) {
    if (roles.some((r) => r.name === d.name)) continue;
    await rest("POST", `/guilds/${GUILD_ID}/roles`, { body: { name: d.name, color: d.color, hoist: false, mentionable: false, permissions: "0" }, reason: "Réseau : rôles de division" });
    console.log(`[discord] rôle créé : ${d.name}`);
  }
}

function categoryId(channels: GuildChannel[], word: string) {
  return channels.find((c) => c.type === TYPE.CATEGORY && norm(c.name).includes(word))?.id ?? null;
}

async function ensureQuizChannel(channels: GuildChannel[]) {
  if (channels.some((c) => c.name === CHANNELS.QUIZ)) return;
  await rest("POST", `/guilds/${GUILD_ID}/channels`, {
    reason: "Réseau : quiz du jour",
    body: {
      name: CHANNELS.QUIZ,
      type: TYPE.TEXT,
      parent_id: categoryId(channels, "communaut"),
      topic: "Une question par jour sur le rail et sur le jeu. Bonne réponse : des pièces pour ta compagnie.",
      permission_overwrites: [
        { id: GUILD_ID, type: 0, deny: bits(P.SEND, P.CREATE_THREADS, P.ADD_REACTIONS) },
        // le bot écrit quand même, sans dépendre de la permission Administrateur
        ...(APP_ID ? [{ id: APP_ID, type: 1, allow: bits(P.VIEW, P.SEND, P.EMBED, P.ATTACH, P.HISTORY) }] : []),
      ],
    },
  });
  console.log(`[discord] salon créé : ${CHANNELS.QUIZ}`);
}

async function ensureGraphisteForum(channels: GuildChannel[]) {
  if (channels.some((c) => c.name === CHANNELS.GRAPHISTE)) return;
  const graphiste = await graphisteRoleId();
  if (!graphiste) warn("aucun rôle dont le nom contient « graphiste » : le forum est créé, mais personne d'autre que le staff ne pourra y gérer les posts");
  const body = {
    name: CHANNELS.GRAPHISTE,
    parent_id: categoryId(channels, "support"),
    topic: "Une idée d'habillage, de livrée, d'emblème ou de décor ? Un post par idée, avec une image ou une référence si tu en as. Le graphiste du jeu y répond.",
    permission_overwrites: graphiste ? [{ id: graphiste, type: 0, allow: bits(P.VIEW, P.SEND, P.SEND_IN_THREADS, P.MANAGE_THREADS, P.MANAGE_MESSAGES) }] : [],
  };
  try {
    await rest("POST", `/guilds/${GUILD_ID}/channels`, { reason: "Réseau : suggestions pour le graphiste", body: { ...body, type: TYPE.FORUM } });
  } catch (err) {
    // les forums demandent le mode Communauté : à défaut, un salon texte
    if (!(err instanceof DiscordError) || err.status !== 400) throw err;
    await rest("POST", `/guilds/${GUILD_ID}/channels`, { reason: "Réseau : suggestions pour le graphiste", body: { ...body, type: TYPE.TEXT } });
    warn(`${CHANNELS.GRAPHISTE} créé en salon texte : active le mode Communauté pour en faire un forum avec étiquettes`);
  }
  console.log(`[discord] salon créé : ${CHANNELS.GRAPHISTE}`);
}

async function ensureForumTags(channels: GuildChannel[]) {
  for (const kind of FORUM_KINDS) {
    const forum = channels.find((c) => c.name === CHANNELS[kind]);
    if (!forum || forum.type !== TYPE.FORUM) continue;
    const have = forum.available_tags ?? [];
    const wanted = [...new Set(Object.values(STATUS_TAGS[kind]))];
    const missing = wanted.filter((name) => !have.some((t) => t.name === name)).slice(0, Math.max(0, 20 - have.length));
    if (!missing.length) continue;
    const tags: ForumTag[] = [...have, ...missing.map((name) => ({ name, moderated: true }))];
    await rest("PATCH", `/channels/${forum.id}`, { body: { available_tags: tags }, reason: "Réseau : étiquettes de suivi" });
    console.log(`[discord] étiquettes ajoutées à ${forum.name} : ${missing.join(", ")}`);
  }
}

let done: Promise<void> | null = null;

/* Appelé au démarrage du serveur et à la connexion du bot : une seule
   exécution, les deux attendent la même. */
export function provisionDiscord() {
  if (!botEnabled()) return Promise.resolve();
  done ??= (async () => {
    const steps: [string, () => Promise<void>][] = [
      ["rôles de division", ensureDivisionRoles],
      ["salon du quiz", async () => ensureQuizChannel(await guildChannels(true))],
      ["forum du graphiste", async () => ensureGraphisteForum(await guildChannels(true))],
      ["étiquettes des forums", async () => ensureForumTags(await guildChannels(true))],
    ];
    for (const [label, fn] of steps) {
      try {
        await fn();
      } catch (err) {
        const e = err as Error;
        warn(
          err instanceof DiscordError && err.status === 403
            ? `${label} : permission refusée. Donne au rôle du bot « Gérer les rôles » et « Gérer les salons » (Paramètres du serveur → Rôles), puis redémarre.`
            : `${label} : ${e.message}`
        );
      }
    }
    forgetGuildCache();
  })();
  return done;
}

/* Le forum (suggestions, bugs, graphiste) auquel appartient un fil, d'après
   l'identifiant de son salon parent. */
export async function forumKindOf(parentId: string | null | undefined): Promise<{ kind: ForumKind; forum: GuildChannel } | null> {
  if (!parentId) return null;
  const forum = (await guildChannels()).find((c) => c.id === parentId);
  if (!forum) return null;
  const kind = FORUM_KINDS.find((k) => CHANNELS[k] === forum.name);
  return kind ? { kind, forum } : null;
}
