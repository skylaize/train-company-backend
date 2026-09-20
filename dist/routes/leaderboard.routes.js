"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.leaderboardRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const leaderboard_controller_1 = require("../controllers/leaderboard.controller");
exports.leaderboardRouter = (0, express_1.Router)();
exports.leaderboardRouter.get("/leaderboard", auth_middleware_1.requireAuth, leaderboard_controller_1.getLeaderboard);
