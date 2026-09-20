"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.networkRouter = void 0;
const express_1 = require("express");
const network_controller_1 = require("../controllers/network.controller");
exports.networkRouter = (0, express_1.Router)();
exports.networkRouter.get("/network/stats", network_controller_1.getNetworkStats);
