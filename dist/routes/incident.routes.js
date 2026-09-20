"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.incidentRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const incident_controller_1 = require("../controllers/incident.controller");
exports.incidentRouter = (0, express_1.Router)();
exports.incidentRouter.get("/incidents/mine", auth_middleware_1.requireAuth, incident_controller_1.listMyIncidents);
