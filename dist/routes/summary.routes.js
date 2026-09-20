"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.summaryRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const summary_controller_1 = require("../controllers/summary.controller");
exports.summaryRouter = (0, express_1.Router)();
exports.summaryRouter.get("/summary/today", auth_middleware_1.requireAuth, summary_controller_1.getTodaySummary);
