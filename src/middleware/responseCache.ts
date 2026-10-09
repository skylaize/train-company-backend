import { Request, Response, NextFunction } from "express";

/* ============================================================
   2.0 : cache court des réponses lourdes.

   Chaque tableau de bord ouvert redemandait toutes les dix secondes des
   calculs coûteux (succès : une cinquantaine de requêtes, carrière,
   classement…), alors que leur résultat ne bouge qu'à la minute. Ici, la
   réponse d'une adresse est gardée quelques secondes pour CE joueur (la clé
   contient son jeton), et des appels simultanés identiques n'en déclenchent
   qu'un seul calcul.

   Toute action du joueur (POST, PATCH, DELETE) vide son cache : après avoir
   réclamé un défi ou une récompense, il voit tout de suite le résultat.
   ============================================================ */

const RULES: { path: RegExp; ttl: number; shared?: boolean }[] = [
  { path: /^\/api\/achievements\/mine$/, ttl: 60_000 },
  { path: /^\/api\/career\/mine$/, ttl: 60_000 },
  { path: /^\/api\/referral\/mine$/, ttl: 120_000 },
  { path: /^\/api\/leaderboard$/, ttl: 20_000 },
  { path: /^\/api\/daily-challenge\/mine$/, ttl: 20_000 },
  { path: /^\/api\/summary\/today$/, ttl: 20_000 },
  { path: /^\/api\/transactions\/mine$/, ttl: 10_000 },
  { path: /^\/api\/news$/, ttl: 30_000 },
  { path: /^\/api\/world$/, ttl: 30_000 },
  { path: /^\/api\/season$/, ttl: 20_000 },
  { path: /^\/api\/weather\/stations$/, ttl: 120_000, shared: true },
  { path: /^\/api\/gazette$/, ttl: 120_000, shared: true },
  { path: /^\/api\/network\/stats$/, ttl: 15_000, shared: true },
];

type Entry = { at: number; ttl: number; owner: string; status: number; body: unknown };
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry | null>>();
const MAX_ENTRIES = 5000;

function ownerOf(req: Request) {
  return String(req.headers.authorization ?? "anon");
}

function sweep(now: number) {
  if (store.size < MAX_ENTRIES) return;
  for (const [k, e] of store) if (now - e.at > e.ttl) store.delete(k);
  // toujours trop : on vide les plus anciennes
  if (store.size >= MAX_ENTRIES) [...store.keys()].slice(0, store.size - MAX_ENTRIES / 2).forEach((k) => store.delete(k));
}

export function responseCache(req: Request, res: Response, next: NextFunction) {
  const owner = ownerOf(req);

  // une action du joueur : son cache est vidé une fois la réponse partie
  if (req.method !== "GET") {
    res.on("finish", () => {
      for (const [k, e] of store) if (e.owner === owner) store.delete(k);
    });
    return next();
  }

  const rule = RULES.find((r) => r.path.test(req.path));
  if (!rule) return next();

  const key = `${rule.shared ? "*" : owner}|${req.originalUrl}`;
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.at < hit.ttl) {
    res.setHeader("X-Cache", "HIT");
    return res.status(hit.status).json(hit.body);
  }

  // même demande déjà en cours : on attend son résultat au lieu de recalculer
  const pending = inflight.get(key);
  if (pending) {
    pending.then((e) => {
      if (e && !res.headersSent) {
        res.setHeader("X-Cache", "WAIT");
        res.status(e.status).json(e.body);
      } else if (!res.headersSent) next();
    });
    return;
  }

  let resolve!: (e: Entry | null) => void;
  inflight.set(key, new Promise<Entry | null>((r) => (resolve = r)));
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    let entry: Entry | null = null;
    if (res.statusCode === 200) {
      entry = { at: Date.now(), ttl: rule.ttl, owner: rule.shared ? "*" : owner, status: 200, body };
      store.set(key, entry);
      sweep(Date.now());
    }
    inflight.delete(key);
    resolve(entry);
    return json(body);
  };
  // la route a planté ou répondu autrement qu'en JSON : on libère les suivants
  res.on("close", () => {
    if (inflight.get(key)) {
      inflight.delete(key);
      resolve(null);
    }
  });
  res.setHeader("X-Cache", "MISS");
  next();
}
