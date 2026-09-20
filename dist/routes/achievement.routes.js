"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.achievementRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const achievement_controller_1 = require("../controllers/achievement.controller");
exports.achievementRouter = (0, express_1.Router)();
exports.achievementRouter.get("/achievements/mine", auth_middleware_1.requireAuth, achievement_controller_1.listMyAchievements);
