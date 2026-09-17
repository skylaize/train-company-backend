import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getCurrentWeather } from "../controllers/weather.controller";

export const weatherRouter = Router();

weatherRouter.get("/weather/current", requireAuth, getCurrentWeather);
