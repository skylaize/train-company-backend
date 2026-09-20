"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.register = register;
exports.login = login;
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = require("../prisma");
const JWT_SECRET = process.env.JWT_SECRET;
async function register(req, res) {
    const { email, pseudo, password } = req.body;
    if (!email || !pseudo || !password) {
        return res.status(400).json({ error: "email, pseudo et password sont requis" });
    }
    const existing = await prisma_1.prisma.user.findUnique({ where: { email } });
    if (existing) {
        return res.status(409).json({ error: "Un compte existe déjà avec cet email" });
    }
    const hashed = await bcrypt_1.default.hash(password, 10);
    const user = await prisma_1.prisma.user.create({
        data: { email, pseudo, password: hashed },
    });
    const token = jsonwebtoken_1.default.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
    return res.status(201).json({
        token,
        user: { id: user.id, email: user.email, pseudo: user.pseudo },
    });
}
async function login(req, res) {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: "email et password sont requis" });
    }
    const user = await prisma_1.prisma.user.findUnique({ where: { email } });
    if (!user) {
        return res.status(401).json({ error: "Identifiants invalides" });
    }
    const valid = await bcrypt_1.default.compare(password, user.password);
    if (!valid) {
        return res.status(401).json({ error: "Identifiants invalides" });
    }
    const token = jsonwebtoken_1.default.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({
        token,
        user: { id: user.id, email: user.email, pseudo: user.pseudo },
    });
}
