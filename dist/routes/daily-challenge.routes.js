"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dailyChallengeRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const daily_challenge_controller_1 = require("../controllers/daily-challenge.controller");
exports.dailyChallengeRouter = (0, express_1.Router)();
exports.dailyChallengeRouter.get("/daily-challenge/mine", auth_middleware_1.requireAuth, daily_challenge_controller_1.getMyDailyChallenge);
exports.dailyChallengeRouter.post("/daily-challenge/claim", auth_middleware_1.requireAuth, daily_challenge_controller_1.claimDailyChallenge);
