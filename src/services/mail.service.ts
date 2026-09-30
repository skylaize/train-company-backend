import nodemailer from "nodemailer";

/* Envoi d'e-mails (1.6) : seulement pour « Mot de passe oublié ».
   SMTP_URL au format smtps://utilisateur:motdepasse@smtp.exemple.fr:465
   (Brevo, Mailjet, OVH, Gmail avec un mot de passe d'application…).
   Sans SMTP_URL, la fonction reste cachée sur l'écran de connexion. */

const SMTP_URL = process.env.SMTP_URL || "";
const MAIL_FROM = process.env.MAIL_FROM || "Réseau <no-reply@compagnie.skhost.fr>";

let transport: nodemailer.Transporter | null = null;

export function mailEnabled() {
  return !!SMTP_URL;
}

export async function sendMail(to: string, subject: string, text: string) {
  if (!SMTP_URL) throw new Error("SMTP_URL absent");
  transport ??= nodemailer.createTransport(SMTP_URL);
  await transport.sendMail({ from: MAIL_FROM, to, subject, text });
}
