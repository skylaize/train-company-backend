import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { buildLeaderRows, rankRows, BOARDS, BoardId } from "../services/leaderboard.service";

const TOP_SIZE = 20;

export async function getLeaderboard(req: AuthRequest, res: Response) {
  const asked = String(req.query.board ?? "valeur");
  const board = (BOARDS.some((b) => b.id === asked) ? asked : "valeur") as BoardId;
  const meta = BOARDS.find((b) => b.id === board)!;

  const [rows, me] = await Promise.all([
    buildLeaderRows(),
    prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true } }),
  ]);

  const ranked = rankRows(rows, board);
  const myId = me?.id ?? null;
  const mine = myId ? ranked.find((r) => r.id === myId) ?? null : null;

  const decorate = (r: (typeof ranked)[number]) => ({
    rank: r.rank,
    id: r.id,
    name: r.name,
    liveryColor: r.liveryColor,
    grade: r.grade,
    title: r.title,
    trains: r.trains,
    lines: r.lines,
    metric: r[board],
    isMe: r.id === myId,
  });

  const entries = ranked.slice(0, TOP_SIZE).map(decorate);

  /* Hors du top, on renvoie le voisinage immédiat : deux concurrents devant,
     la compagnie du joueur, un poursuivant. Sans ça, un 47e ne voit rien de lui. */
  let around: ReturnType<typeof decorate>[] = [];
  if (mine && mine.rank > TOP_SIZE) {
    const from = Math.max(0, mine.rank - 3);
    around = ranked.slice(from, mine.rank + 1).map(decorate);
  }

  const ahead = mine && mine.rank > 1 ? ranked[mine.rank - 2] : null;

  return res.json({
    board,
    label: meta.label,
    note: meta.note,
    missing: meta.missing,
    unit: meta.unit,
    boards: BOARDS.map((b) => ({ id: b.id, label: b.label })),
    total: ranked.length,
    entries,
    around,
    me: mine
      ? {
          eligible: true,
          rank: mine.rank,
          metric: mine[board],
          inTop: mine.rank <= TOP_SIZE,
          // l'écart exact avec la compagnie juste devant : un objectif atteignable
          gap: ahead ? ahead[board] - mine[board] : 0,
          aheadName: ahead ? ahead.name : null,
        }
      : myId
      ? { eligible: false, rank: 0, metric: 0, inTop: false, gap: 0, aheadName: null }
      : null,
  });
}
