"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const prisma_1 = require("../prisma");
exports.userRouter = (0, express_1.Router)();
exports.userRouter.get("/me", auth_middleware_1.requireAuth, async (req, res) => {
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: req.userId },
        select: { id: true, email: true, pseudo: true, createdAt: true, company: true },
    });
    if (!user) {
        return res.status(404).json({ error: "Utilisateur introuvable" });
    }
    return res.json(user);
});
