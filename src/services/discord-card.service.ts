import fs from "fs";
import path from "path";

/* ============================================================
   Carte de profil en image, pour /profil (2.8).

   Dessinée en SVG puis convertie en PNG par resvg, avec les polices du
   jeu (Barlow Condensed, Barlow, Space Mono) embarquées dans
   assets/fonts : aucun besoin de polices installées sur le serveur.

   Si le rendu échoue (module absent, police manquante), profileCard
   renvoie null et /profil retombe sur sa réponse en texte.
   ============================================================ */

export type CardData = {
  name: string;
  title: string | null;
  color: string; // livrée, #rrggbb
  grade: string | null;
  value: number | null;
  rank: number | null;
  total: number | null;
  trains: number | null;
  lines: number | null;
  season: { name: string; division: string; group: number; place: number; points: number } | null;
  alliance: { name: string; chief: boolean } | null;
  premium: boolean;
  pioneer: number | null;
  founded: Date;
  discordName: string | null;
  avatar: Buffer | null; // PNG
};

const FONT_DIR = path.resolve(__dirname, "../../assets/fonts");
const FONTS = ["BarlowCondensed-SemiBold.ttf", "BarlowCondensed-Medium.ttf", "Barlow-Medium.ttf", "SpaceMono-Bold.ttf"].map((f) => path.join(FONT_DIR, f));

const W = 1000;
const H = 440;
const BG = "#12161d";
const PANEL = "#1b212b";
const LINE = "#2a323f";
const TEXT = "#f1f5f9";
const MUTED = "#8b98a9";
const GOLD = "#f2a900";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// les polices embarquées n'ont pas d'emojis : on les retire plutôt que d'afficher des carrés
const plain = (s: string) => s.replace(/[\p{Extended_Pictographic}‍️]/gu, "").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const fmt = (n: number) => new Intl.NumberFormat("fr-FR").format(Math.round(n)).replace(/[  ]/g, " ");
const safeColor = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c : GOLD);

const DIVISION_COLORS: Record<string, string> = { Bronze: "#b0703c", Argent: "#a8b3bd", Or: "#e0b100", Platine: "#6fd3e8" };

function tile(x: number, y: number, w: number, label: string, value: string, sub: string) {
  return `
  <rect x="${x}" y="${y}" width="${w}" height="112" rx="10" fill="${PANEL}" stroke="${LINE}"/>
  <text x="${x + 20}" y="${y + 32}" font-family="Space Mono" font-weight="700" font-size="14" fill="${MUTED}" letter-spacing="2">${xml(label)}</text>
  <text x="${x + 20}" y="${y + 72}" font-family="Barlow Condensed" font-weight="600" font-size="36" fill="${TEXT}">${xml(value)}</text>
  <text x="${x + 20}" y="${y + 97}" font-family="Barlow" font-weight="500" font-size="16" fill="${MUTED}">${xml(sub)}</text>`;
}

function badge(x: number, y: number, label: string, fill: string, color: string) {
  const w = Math.round(label.length * 9.4 + 28);
  return {
    w,
    svg: `<rect x="${x}" y="${y}" width="${w}" height="30" rx="15" fill="${fill}"/><text x="${x + w / 2}" y="${y + 21}" text-anchor="middle" font-family="Space Mono" font-weight="700" font-size="14" fill="${color}" letter-spacing="1">${xml(label)}</text>`,
  };
}

export function cardSvg(d: CardData) {
  const livery = safeColor(d.color);
  const name = clip(plain(d.name) || "Compagnie", 30);
  const nameSize = name.length > 22 ? 48 : 60;
  const subtitle = [d.title ? plain(d.title) : null, d.grade].filter(Boolean).join("  ·  ");
  const textX = d.avatar ? 190 : 64;

  const badges: string[] = [];
  let bx = textX;
  const push = (label: string, fill: string, color: string) => {
    const b = badge(bx, 142, label, fill, color);
    badges.push(b.svg);
    bx += b.w + 10;
  };
  if (d.premium) push("PREMIUM", "#7c3aed", "#ffffff");
  if (d.season) push(d.season.division.toUpperCase(), DIVISION_COLORS[d.season.division] ?? GOLD, "#12161d");
  if (d.pioneer) push(`PIONNIER N°${d.pioneer}`, GOLD, "#12161d");
  if (d.alliance?.chief) push("CHEF D'ALLIANCE", "#0f766e", "#ffffff");

  const tiles = [
    tile(64, 212, 280, "VALEUR", d.value !== null ? `${fmt(d.value)} pi.` : "—", d.rank && d.total ? `${d.rank}e sur ${fmt(d.total)} compagnies` : "Pas encore classée"),
    tile(360, 212, 280, "FLOTTE", d.trains !== null ? `${d.trains} rame${d.trains > 1 ? "s" : ""}` : "—", d.lines !== null ? `${d.lines} ligne${d.lines > 1 ? "s" : ""} en service` : ""),
    d.season
      ? tile(656, 212, 280, "SAISON", `${fmt(d.season.points)} pts`, `${d.season.place}e du groupe ${d.season.group} · ${d.season.division}`)
      : tile(656, 212, 280, "SAISON", "—", "Pas encore engagée"),
  ];

  const founded = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "Europe/Paris" }).format(d.founded);
  const footLeft = [d.alliance ? `Alliance ${clip(plain(d.alliance.name), 28)}` : null, `Fondée le ${founded}`].filter(Boolean).join("  ·  ");
  const avatar = d.avatar
    ? `<clipPath id="a"><circle cx="118" cy="110" r="54"/></clipPath>
  <image x="64" y="56" width="108" height="108" clip-path="url(#a)" href="data:image/png;base64,${d.avatar.toString("base64")}"/>
  <circle cx="118" cy="110" r="55" fill="none" stroke="${livery}" stroke-width="4"/>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" rx="18" fill="${BG}"/>
  <rect width="${W}" height="14" fill="${livery}"/>
  <rect y="14" width="${W}" height="3" fill="${livery}" opacity="0.35"/>
  <g stroke="${LINE}" stroke-width="2">
    <line x1="0" y1="396" x2="${W}" y2="396"/>
  </g>
  ${avatar}
  <text x="${textX}" y="98" font-family="Barlow Condensed" font-weight="600" font-size="${nameSize}" fill="${TEXT}">${xml(name)}</text>
  <text x="${textX}" y="128" font-family="Barlow" font-weight="500" font-size="20" fill="${MUTED}">${xml(clip(subtitle, 70))}</text>
  ${badges.join("\n  ")}
  ${tiles.join("")}
  <text x="64" y="366" font-family="Barlow" font-weight="500" font-size="18" fill="${MUTED}">${xml(footLeft)}</text>
  <text x="64" y="424" font-family="Space Mono" font-weight="700" font-size="15" fill="${GOLD}" letter-spacing="3">RÉSEAU</text>
  <text x="${W - 64}" y="424" text-anchor="end" font-family="Space Mono" font-weight="700" font-size="14" fill="${MUTED}">${xml(d.discordName ? `@${clip(plain(d.discordName), 24)}  ·  compagnie.skhost.fr` : "compagnie.skhost.fr")}</text>
</svg>`;
}

type ResvgModule = { Resvg: new (svg: string, opts: unknown) => { render(): { asPng(): Buffer } } };
let resvg: ResvgModule | null | undefined;
let warned = false;

function load(): ResvgModule | null {
  if (resvg !== undefined) return resvg;
  try {
    if (!FONTS.every((f) => fs.existsSync(f))) throw new Error(`polices absentes de ${FONT_DIR}`);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    resvg = require("@resvg/resvg-js") as ResvgModule;
  } catch (err) {
    resvg = null;
    if (!warned) console.warn("[discord] carte de profil indisponible (/profil répondra en texte) :", (err as Error).message);
    warned = true;
  }
  return resvg;
}

/* La carte en PNG, ou null si le rendu n'est pas possible. */
export function profileCard(d: CardData): Buffer | null {
  const mod = load();
  if (!mod) return null;
  try {
    return new mod.Resvg(cardSvg(d), { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Barlow" }, fitTo: { mode: "width", value: W } }).render().asPng();
  } catch (err) {
    console.error("[discord] carte de profil :", (err as Error).message);
    return null;
  }
}

/* L'avatar Discord d'un membre, en PNG. Jamais bloquant : null au moindre souci. */
export async function fetchAvatar(discordId: string, hash: string | null | undefined): Promise<Buffer | null> {
  if (!hash || !/^[a-z0-9_]+$/i.test(hash)) return null;
  try {
    const r = await fetch(`https://cdn.discordapp.com/avatars/${discordId}/${hash}.png?size=128`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}
