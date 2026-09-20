"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.weatherRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const weather_controller_1 = require("../controllers/weather.controller");
exports.weatherRouter = (0, express_1.Router)();
exports.weatherRouter.get("/weather/current", auth_middleware_1.requireAuth, weather_controller_1.getCurrentWeather);
