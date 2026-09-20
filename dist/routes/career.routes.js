"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.careerRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const career_controller_1 = require("../controllers/career.controller");
exports.careerRouter = (0, express_1.Router)();
exports.careerRouter.get("/career/mine", auth_middleware_1.requireAuth, career_controller_1.getMyCareer);
