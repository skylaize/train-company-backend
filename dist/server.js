"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const auth_routes_1 = require("./routes/auth.routes");
const user_routes_1 = require("./routes/user.routes");
const company_routes_1 = require("./routes/company.routes");
const line_routes_1 = require("./routes/line.routes");
const train_routes_1 = require("./routes/train.routes");
const contract_routes_1 = require("./routes/contract.routes");
const leaderboard_routes_1 = require("./routes/leaderboard.routes");
const incident_routes_1 = require("./routes/incident.routes");
const transaction_routes_1 = require("./routes/transaction.routes");
const achievement_routes_1 = require("./routes/achievement.routes");
const daily_challenge_routes_1 = require("./routes/daily-challenge.routes");
const staff_routes_1 = require("./routes/staff.routes");
const weather_routes_1 = require("./routes/weather.routes");
const account_routes_1 = require("./routes/account.routes");
const summary_routes_1 = require("./routes/summary.routes");
const network_routes_1 = require("./routes/network.routes");
const career_routes_1 = require("./routes/career.routes");
const referral_routes_1 = require("./routes/referral.routes");
const ads_routes_1 = require("./routes/ads.routes");
const mission_routes_1 = require("./routes/mission.routes");
const billing_routes_1 = require("./routes/billing.routes");
const market_routes_1 = require("./routes/market.routes");
const construction_routes_1 = require("./routes/construction.routes");
const billing_controller_1 = require("./controllers/billing.controller");
const simulation_job_1 = require("./jobs/simulation.job");
const app = (0, express_1.default)();
// CORS entièrement ouvert : reflète l'origine de la requête (équivalent à "*" mais
// plus robuste avec les requêtes de pré-vérification/preflight et les en-têtes personnalisés)
const corsOptions = {
    origin: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
};
app.use((0, cors_1.default)(corsOptions));
app.options("*", (0, cors_1.default)(corsOptions));
/* Le webhook Stripe doit recevoir le corps BRUT : la vérification de signature
   porte sur les octets exacts envoyés par Stripe. Il est donc monté avant
   express.json(), sinon le corps serait déjà décodé et la signature invalide.
   C'est l'erreur la plus courante de cette intégration. */
app.post("/api/stripe/webhook", express_1.default.raw({ type: "application/json" }), billing_controller_1.handleStripeWebhook);
app.use(express_1.default.json());
app.get("/", (_req, res) => {
    res.json({ status: "ok", service: "train-company-backend" });
});
app.use("/api/auth", auth_routes_1.authRouter);
app.use("/api", user_routes_1.userRouter);
app.use("/api", company_routes_1.companyRouter);
app.use("/api", line_routes_1.lineRouter);
app.use("/api", train_routes_1.trainRouter);
app.use("/api", contract_routes_1.contractRouter);
app.use("/api", leaderboard_routes_1.leaderboardRouter);
app.use("/api", mission_routes_1.missionRouter);
app.use("/api", billing_routes_1.billingRouter);
app.use("/api", market_routes_1.marketRouter);
app.use("/api", construction_routes_1.constructionRouter);
app.use("/api", incident_routes_1.incidentRouter);
app.use("/api", transaction_routes_1.transactionRouter);
app.use("/api", achievement_routes_1.achievementRouter);
app.use("/api", daily_challenge_routes_1.dailyChallengeRouter);
app.use("/api", staff_routes_1.staffRouter);
app.use("/api", weather_routes_1.weatherRouter);
app.use("/api", account_routes_1.accountRouter);
app.use("/api", summary_routes_1.summaryRouter);
app.use("/api", network_routes_1.networkRouter);
app.use("/api", career_routes_1.careerRouter);
app.use("/api", referral_routes_1.referralRouter);
app.use("/api", ads_routes_1.adsRouter);
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
    (0, simulation_job_1.startSimulationJob)();
});
