import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { weatherView, severeWeather, WEATHER_EFFECTS } from "../services/realweather.service";

/* 2.0 : la vraie météo des gares (MET Norway). */

export async function getStationWeather(_req: AuthRequest, res: Response) {
  res.json(await weatherView());
}

/* Gardé pour les clients d'avant la 2.0 : la météo la plus marquante du réseau. */
export async function getCurrentWeather(_req: AuthRequest, res: Response) {
  const severe = await severeWeather();
  const order = ["ORAGE", "VERGLAS", "NEIGE", "BROUILLARD", "CANICULE"] as const;
  const kind = order.find((k) => severe.has(k));
  if (!kind) return res.json({ type: "CLAIR", label: null, endsAt: null });
  const where = severe.get(kind)!.slice(0, 3).join(", ");
  return res.json({ type: kind, label: `${WEATHER_EFFECTS[kind].label} à ${where}`, endsAt: null });
}
