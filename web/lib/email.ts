import nodemailer from "nodemailer";

export function emailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST);
}

/** Returns false rather than throwing: an owner can still copy the invite link by hand. */
export async function sendEmail(
  to: string,
  subject: string,
  text: string,
): Promise<boolean> {
  if (!emailConfigured()) return false;
  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 25),
      secure: false,
      requireTLS: process.env.SMTP_STARTTLS === "true",
      ignoreTLS: process.env.SMTP_STARTTLS !== "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    });
    await transport.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      text,
    });
    return true;
  } catch (error) {
    console.error("could not send email", error);
    return false;
  }
}
