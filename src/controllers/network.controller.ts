import { Request, Response } from 'express';
import { prisma } from '../prisma';

export const getNetworkMap = async (req: Request, res: Response) => {
  try {
    // 1. Récupération optimisée des gares (uniquement les champs nécessaires à l'affichage de la carte)
    const stations = await prisma.station.findMany({
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        type: true,
        companyId: true,
      },
    });

    // 2. Récupération optimisée des voies/segments sans charger toute la base en cascade
    const tracks = await prisma.track.findMany({
      select: {
        id: true,
        fromStationId: true,
        toStationId: true,
        status: true,
        electrified: true,
        speedLimit: true,
      },
    });

    // 3. Réponse JSON allégée pour libérer immédiatement les connexions du pool Prisma
    return res.status(200).json({
      success: true,
      stations,
      tracks,
    });
  } catch (error) {
    console.error('[API] Erreur GET /api/network/map :', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Erreur interne lors du chargement de la carte du réseau.' 
    });
  }
};
