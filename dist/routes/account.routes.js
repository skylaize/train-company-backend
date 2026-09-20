"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.accountRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const account_controller_1 = require("../controllers/account.controller");
exports.accountRouter = (0, express_1.Router)();
exports.accountRouter.post("/account/change-password", auth_middleware_1.requireAuth, account_controller_1.changePassword);
exports.accountRouter.delete("/account", auth_middleware_1.requireAuth, account_controller_1.deleteAccount);
