"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.referralRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const referral_controller_1 = require("../controllers/referral.controller");
exports.referralRouter = (0, express_1.Router)();
exports.referralRouter.get("/referral/mine", auth_middleware_1.requireAuth, referral_controller_1.getMyReferral);
