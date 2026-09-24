import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

export const WEATHER_LABELS: Record<string, string> = {
  BROUILLARD: "Brouillard sur le réseau — trains ralentis",
  CANICULE: "Canicule — usure du matériel accélérée",
  VERGLAS: "Verglas — risque de retard accru",
  NEIGE: "Neige sur le réseau — trains ralentis, retards plus fréquents",
};

export async function getCurrentWeather(_req: AuthRequest, res: Response) {
  const active = await prisma.weatherEvent.findFirst({
    where: { endsAt: { gt: new Date() } },
    orderBy: { startedAt: "desc" },
  });

  if (!active) {
    return res.json({ type: "CLAIR", label: null, endsAt: null });
  }

  return res.json({ type: active.type, label: WEATHER_LABELS[active.type], endsAt: active.endsAt });
}
