import { prisma } from "../prisma";
import { botEnabled, Embed, esc, rest } from "./discord.service";
import { ForumKind, forumKindOf, graphisteRoleId, P, Status, STATUS_TAGS, TYPE } from "./discord-provision.service";

/* ============================================================
   Suivi des suggestions et des bugs (2.8).

   Dans les forums 💡・suggestions, 🐛・bugs et 🎨・suggestions-graphiste :
   - à chaque nouveau post, le bot pose l'étiquette de départ, ajoute les
     réactions 👍 👎 pour voter (idées) et rappelle quoi fournir (bugs) ;
   - /suivi, tapée dans un post, change son étiquette et écrit où il en
     est, en mentionnant son auteur : « à l'étude », « prévue pour la
     2.9 », « ajoutée en 2.9 »…

   /suivi est ouverte à qui peut « Gérer les fils » dans le salon : le
   staff partout, et le rôle Graphiste dans son forum.
   ============================================================ */

export const SUIVI_CHOICES = [
  { name: "🔍 À l'étude (bug : confirmé)", value: "etude" },
  { name: "👍 Acceptée (bug : confirmé)", value: "accepte" },
  { name: "📅 Prévue (bug : correction en cours)", value: "prevu" },
  { name: "✅ Ajoutée au jeu (bug : corrigé)", value: "fait" },
  { name: "❌ Refusée (bug : pas un bug)", value: "refuse" },
];

const COLORS: Record<Status, number> = { nouveau: 0x64748b, etude: 0x38bdf8, accepte: 0x10b981, prevu: 0xf2a900, fait: 0x10b981, refuse: 0xef4444 };

function statusText(kind: ForumKind, status: Status, version: string | undefined) {
  const v = version ? ` ${esc(version)}` : "";
  if (kind === "BUGS") {
    if (status === "etude" || status === "accepte") return { title: "🔍 Bug confirmé", body: "On arrive à le reproduire. Il est dans la liste des corrections." };
    if (status === "prevu") return { title: "🛠️ Correction en cours", body: version ? `Le correctif est prévu pour la version${v}.` : "Le correctif est en cours d'écriture." };
    if (status === "fait") return { title: "✅ Corrigé", body: version ? `Le correctif est sorti avec la version${v}. Merci pour le signalement !` : "Le correctif est en ligne. Merci pour le signalement !" };
    return { title: "❌ Pas un bug", body: "Ce comportement est voulu, ou vient d'ailleurs que du jeu." };
  }
  if (status === "etude") return { title: "🔍 À l'étude", body: "L'équipe regarde cette idée de près." };
  if (status === "accepte") return { title: "👍 Acceptée", body: "L'idée est retenue. Reste à lui trouver une place dans le planning." };
  if (status === "prevu") return { title: "📅 Prévue", body: version ? `Elle est au programme de la version${v}.` : "Elle est au programme d'une prochaine version." };
  if (status === "fait") return { title: "✅ Ajoutée au jeu", body: version ? `Elle est sortie avec la version${v}. Merci pour l'idée !` : "Elle est en ligne. Merci pour l'idée !" };
  return { title: "❌ Refusée", body: "L'idée ne sera pas retenue pour le moment." };
}

type Thread = { id: string; type: number; parent_id?: string | null; owner_id?: string; applied_tags?: string[] };

/* Les étiquettes du fil avec le nouveau statut à la place de l'ancien. */
function retag(kind: ForumKind, forumTags: { id?: string; name: string }[], applied: string[], status: Status) {
  const statusNames = new Set(Object.values(STATUS_TAGS[kind]));
  const statusIds = new Set(forumTags.filter((t) => statusNames.has(t.name)).map((t) => t.id));
  const target = forumTags.find((t) => t.name === STATUS_TAGS[kind][status])?.id;
  const kept = applied.filter((id) => !statusIds.has(id));
  return target ? [...kept.slice(0, 4), target] : null; // Discord : cinq étiquettes au plus
}

/* /suivi, tapée dans un post de forum. Renvoie le texte affiché au staff seul. */
export async function suiviCommand(channelHere: string, permissions: string | undefined, status: string | undefined, version: string | undefined, note: string | undefined, staffId: string) {
  let perms = 0n;
  try {
    perms = BigInt(permissions ?? "0");
  } catch {
    /* permissions illisibles : traité comme aucune */
  }
  const thread = await rest<Thread>("GET", `/channels/${channelHere}`).catch(() => null);
  const where = thread && (thread.type === 11 || thread.type === 12) ? await forumKindOf(thread.parent_id) : null;
  if (!thread || !where) return "À utiliser dans un post de 💡・suggestions, 🐛・bugs ou 🎨・suggestions-graphiste.";
  if ((perms & (1n << 3n)) === 0n && (perms & P.MANAGE_THREADS) === 0n) return "Seuls le staff et le graphiste (dans son forum) peuvent changer le statut d'un post.";
  if (!status || !(status in COLORS) || status === "nouveau") return "Statut inconnu.";
  const st = status as Status;

  let tagged = false;
  if (where.forum.type === TYPE.FORUM) {
    const tags = retag(where.kind, where.forum.available_tags ?? [], thread.applied_tags ?? [], st);
    if (tags) {
      await rest("PATCH", `/channels/${thread.id}`, { body: { applied_tags: tags, archived: false }, reason: "Réseau : suivi" });
      tagged = true;
    }
  }
  const text = statusText(where.kind, st, version?.trim() || undefined);
  const embed: Embed = {
    title: text.title,
    description: [text.body, note?.trim() ? `\n> ${esc(note.trim())}` : ""].join(""),
    color: COLORS[st],
    footer: { text: "Suivi par l'équipe de Réseau" },
    timestamp: new Date().toISOString(),
  };
  const author = thread.owner_id && thread.owner_id !== staffId ? thread.owner_id : null;
  await rest("POST", `/channels/${thread.id}/messages`, {
    body: { content: author ? `<@${author}>` : undefined, embeds: [embed], allowed_mentions: { parse: [], users: author ? [author] : [] } },
  });
  return `✅ Statut mis à jour : **${text.title}**${tagged ? "" : " (étiquette non posée : elle n'existe pas sur ce forum)"}.`;
}

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/* Un nouveau post dans un des trois forums (événement du gateway). */
export async function onForumPost(threadId: string, parentId: string | null, appliedTags: string[]) {
  if (!botEnabled()) return;
  const where = await forumKindOf(parentId);
  if (!where) return;
  try {
    await prisma.discordPost.create({ data: { key: `suivi:${threadId}`, channelId: parentId ?? "", messageId: "" } });
  } catch {
    return; // déjà traité par l'autre conteneur
  }
  if (where.forum.type === TYPE.FORUM) {
    const tags = retag(where.kind, where.forum.available_tags ?? [], appliedTags, "nouveau");
    if (tags) await rest("PATCH", `/channels/${threadId}`, { body: { applied_tags: tags } }).catch(() => undefined);
  }
  // le premier message d'un post arrive juste après le fil lui-même
  await wait(2500);
  if (where.kind !== "BUGS") {
    for (const emoji of ["👍", "👎"]) {
      await rest("PUT", `/channels/${threadId}/messages/${threadId}/reactions/${encodeURIComponent(emoji)}/@me`).catch(() => undefined);
    }
  }
  const graphiste = where.kind === "GRAPHISTE" ? await graphisteRoleId() : null;
  const lines =
    where.kind === "BUGS"
      ? ["Merci pour le signalement ! Pour qu'on le corrige vite, vérifie que ton post contient :", "• les étapes pour le reproduire", "• une capture d'écran", "• ton navigateur et ton appareil", "", "L'équipe écrira ici où en est la correction."]
      : where.kind === "GRAPHISTE"
        ? ["Merci pour l'idée ! Si tu as une image ou une référence, ajoute-la ici.", "Les autres joueurs peuvent voter avec 👍 👎 sur le premier message. Le graphiste te répondra ici."]
        : ["Merci pour l'idée ! Les autres joueurs peuvent voter avec 👍 👎 sur le premier message.", "L'équipe écrira ici où elle en est : à l'étude, prévue, ajoutée…"];
  await rest("POST", `/channels/${threadId}/messages`, {
    body: {
      content: graphiste ? `<@&${graphiste}>` : undefined,
      embeds: [{ description: lines.join("\n"), color: COLORS.nouveau }],
      allowed_mentions: { parse: [], roles: graphiste ? [graphiste] : [] },
    },
  }).catch((err) => console.error("[discord] suivi, accueil du post :", (err as Error).message));
}
