export function normalizeEmailForMatching(email: string | null | undefined): string | null {
  if (!email) return null;
  let normalized = email.trim().toLowerCase();
  const parts = normalized.split("@");
  if (parts.length !== 2) return normalized;

  let [localPart, domain] = parts;

  if (domain === "gmail.com" || domain === "googlemail.com") {
    localPart = localPart.replace(/\./g, "").split("+")[0];
    domain = "gmail.com";
  }

  const dotIgnoring = ["outlook.com", "hotmail.com", "live.com", "msn.com"];
  if (dotIgnoring.includes(domain)) {
    localPart = localPart.replace(/\./g, "");
  }

  return `${localPart}@${domain}`;
}

export function isSystemSender(email: string | null | undefined, supportEmail: string): boolean {
  if (!email) return true;
  const lower = email.trim().toLowerCase();
  const support = supportEmail.trim().toLowerCase();
  if (lower === support) return true;
  if (lower.endsWith("@google.com")) return true;
  if (lower.endsWith("@twilio.com")) return true;
  if (lower.includes("team.twilio") || lower.includes("teamtwilio")) return true;
  if (lower.includes("sendgrid")) return true;
  return false;
}
