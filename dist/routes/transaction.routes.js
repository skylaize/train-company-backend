"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.transactionRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const transaction_controller_1 = require("../controllers/transaction.controller");
exports.transactionRouter = (0, express_1.Router)();
exports.transactionRouter.get("/transactions/mine", auth_middleware_1.requireAuth, transaction_controller_1.listMyTransactions);
