"use strict";
/* ============================================================
   Entretien du réseau et agrandissement du dépôt.

   Le problème que ces deux règles corrigent : avant, tout ce qu'on pouvait
   acheter dans le jeu coûtait 5 250 pi. au total (plafond de 6 rames et de
   6 places compris), pour un revenu d'environ 1 000 pi./h en continu. Le jeu
   était donc économiquement terminé en cinq heures, et la trésorerie ne
   faisait plus que gonfler sans destination.

   Deux leviers, qui ne valent que pris ensemble :

   1. Le dépôt n'a plus de plafond, mais chaque place coûte 1,7 fois la
      précédente. L'argent a toujours où aller, avec un rendement décroissant.

   2. L'entretien croît avec le CARRÉ du parc. C'est la forme qui compte : une
      charge fixe par rame abaisserait la courbe sans jamais changer sa pente,
      donc la 20e rame rapporterait autant que la 7e. En quadratique, la marge
      de la rame suivante diminue à chaque palier et finit par s'annuler — il
      existe enfin une taille optimale, et la dépasser demande de mieux jouer
      (fret, ordres des donneurs d'ordre, fidélité client) plutôt que d'attendre.
   ============================================================ */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PREMIUM_DEPOT_DISCOUNT = exports.DEPOT_GROWTH = exports.DEPOT_BASE_COST = exports.UPKEEP_K = exports.UPKEEP_FREE_TRAINS = void 0;
exports.upkeepPerTick = upkeepPerTick;
exports.depotExpansionCost = depotExpansionCost;
/* Les rames de départ n'entretiennent rien : une petite compagnie doit rester
   viable sans personnel, sinon le début de partie devient infranchissable. */
exports.UPKEEP_FREE_TRAINS = 2;
/* Calibré pour que la flotte optimale tombe vers 15 places et que la marge de
   la rame suivante passe de +491 pi./h à 6 rames à +11 à 16, puis négative. */
exports.UPKEEP_K = 0.1;
/* Coût d'entretien par tick pour une compagnie de n rames. */
function upkeepPerTick(trainCount) {
    const billable = Math.max(0, trainCount - exports.UPKEEP_FREE_TRAINS);
    return Math.round(exports.UPKEEP_K * billable * billable);
}
exports.DEPOT_BASE_COST = 200;
exports.DEPOT_GROWTH = 1.7;
/* Prix pour passer de `currentSlots` à `currentSlots + 1`.
   Les six premières places coûtent 2 101 pi. cumulés, soit un peu moins que
   les 2 800 de l'ancien barème : personne ne perd au change. Ensuite la pente
   part — la 10e place vaut 8 207 pi., la 14e 68 544. */
/* Remise Premium sur les places de dépôt. C'est volontairement une réduction
   sur un achat ponctuel et non sur l'entretien : alléger l'entretien
   déplacerait le PLAFOND — un payant ferait tourner seize rames là où un
   gratuit en plafonne à quatorze. Une remise sur le dépôt ne change que la
   VITESSE : le payant atteint le même optimum plus tôt, pas plus haut.
   Payer pour aller plus vite se défend, payer pour aller plus haut non. */
exports.PREMIUM_DEPOT_DISCOUNT = 0.2;
function depotExpansionCost(currentSlots, isPremium = false) {
    const base = exports.DEPOT_BASE_COST * Math.pow(exports.DEPOT_GROWTH, Math.max(0, currentSlots - 2));
    return Math.round(base * (isPremium ? 1 - exports.PREMIUM_DEPOT_DISCOUNT : 1));
}
