"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adsRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const ads_controller_1 = require("../controllers/ads.controller");
exports.adsRouter = (0, express_1.Router)();
exports.adsRouter.get("/ads/status", auth_middleware_1.requireAuth, ads_controller_1.getAdStatus);
exports.adsRouter.post("/ads/claim", auth_middleware_1.requireAuth, ads_controller_1.claimAdReward);
