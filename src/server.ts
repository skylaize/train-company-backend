import "dotenv/config";
import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth.routes";
import { userRouter } from "./routes/user.routes";
import { companyRouter } from "./routes/company.routes";
import { lineRouter } from "./routes/line.routes";
import { trainRouter } from "./routes/train.routes";
import { contractRouter } from "./routes/contract.routes";
import { leaderboardRouter } from "./routes/leaderboard.routes";
import { incidentRouter } from "./routes/incident.routes";
import { transactionRouter } from "./routes/transaction.routes";
import { achievementRouter } from "./routes/achievement.routes";
import { dailyChallengeRouter } from "./routes/daily-challenge.routes";
import { staffRouter } from "./routes/staff.routes";
import { weatherRouter } from "./routes/weather.routes";
import { accountRouter } from "./routes/account.routes";
import { summaryRouter } from "./routes/summary.routes";
import { networkRouter } from "./routes/network.routes";
import { careerRouter } from "./routes/career.routes";
import { referralRouter } from "./routes/referral.routes";
import { adsRouter } from "./routes/ads.routes";
import { missionRouter } from "./routes/mission.routes";
import { billingRouter } from "./routes/billing.routes";
import { marketRouter } from "./routes/market.routes";
import { constructionRouter } from "./routes/construction.routes";
import { handleStripeWebhook } from "./controllers/billing.controller";
import { startSimulationJob } from "./jobs/simulation.job";

const app = express();

// CORS entièrement ouvert : reflète l'origine de la requête (équivalent à "*" mais
// plus robuste avec les requêtes de pré-vérification/preflight et les en-têtes personnalisés)
const corsOptions = {
  origin: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

/* Le webhook Stripe doit recevoir le corps BRUT : la vérification de signature
   porte sur les octets exacts envoyés par Stripe. Il est donc monté avant
   express.json(), sinon le corps serait déjà décodé et la signature invalide.
   C'est l'erreur la plus courante de cette intégration. */
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), handleStripeWebhook);

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "train-company-backend" });
});

app.use("/api/auth", authRouter);
app.use("/api", userRouter);
app.use("/api", companyRouter);
app.use("/api", lineRouter);
app.use("/api", trainRouter);
app.use("/api", contractRouter);
app.use("/api", leaderboardRouter);
app.use("/api", missionRouter);
app.use("/api", billingRouter);
app.use("/api", marketRouter);
app.use("/api", constructionRouter);
app.use("/api", incidentRouter);
app.use("/api", transactionRouter);
app.use("/api", achievementRouter);
app.use("/api", dailyChallengeRouter);
app.use("/api", staffRouter);
app.use("/api", weatherRouter);
app.use("/api", accountRouter);
app.use("/api", summaryRouter);
app.use("/api", networkRouter);
app.use("/api", careerRouter);
app.use("/api", referralRouter);
app.use("/api", adsRouter);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  startSimulationJob();
});
