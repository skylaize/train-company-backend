"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.billingRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const billing_controller_1 = require("../controllers/billing.controller");
exports.billingRouter = (0, express_1.Router)();
exports.billingRouter.get("/billing/status", auth_middleware_1.requireAuth, billing_controller_1.getBillingStatus);
exports.billingRouter.post("/billing/checkout", auth_middleware_1.requireAuth, billing_controller_1.createCheckoutSession);
