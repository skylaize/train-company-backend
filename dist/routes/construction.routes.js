"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.constructionRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const construction_controller_1 = require("../controllers/construction.controller");
exports.constructionRouter = (0, express_1.Router)();
exports.constructionRouter.get("/constructions", auth_middleware_1.requireAuth, construction_controller_1.getConstructions);
exports.constructionRouter.post("/constructions", auth_middleware_1.requireAuth, construction_controller_1.startConstruction);
