"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLeaderboard = getLeaderboard;
const prisma_1 = require("../prisma");
const leaderboard_service_1 = require("../services/leaderboard.service");
const TOP_SIZE = 20;
async function getLeaderboard(req, res) {
    const asked = String(req.query.board ?? "valeur");
    const board = (leaderboard_service_1.BOARDS.some((b) => b.id === asked) ? asked : "valeur");
    const meta = leaderboard_service_1.BOARDS.find((b) => b.id === board);
    const [rows, me] = await Promise.all([
        (0, leaderboard_service_1.buildLeaderRows)(),
        prisma_1.prisma.company.findUnique({ where: { ownerId: req.userId }, select: { id: true } }),
    ]);
    const ranked = (0, leaderboard_service_1.rankRows)(rows, board);
    const myId = me?.id ?? null;
    const mine = myId ? ranked.find((r) => r.id === myId) ?? null : null;
    const decorate = (r) => ({
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
    let around = [];
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
        boards: leaderboard_service_1.BOARDS.map((b) => ({ id: b.id, label: b.label })),
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
