-- 2.5 : notifications du jeu en message privé Discord (catégories choisies avec /notifs)
ALTER TABLE "User" ADD COLUMN "discordDm" TEXT NOT NULL DEFAULT '';
