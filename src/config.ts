import "dotenv/config";

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export const config = {
  port: parseInt(process.env.PORT ?? "8101", 10),
  databaseUrl: process.env.BLINK_CASH_ADVANCE_DATABASE_URL?.trim() || req("DATABASE_URL"),
  gmail: {
    clientId: req("GMAIL_CLIENT_ID"),
    clientSecret: req("GMAIL_CLIENT_SECRET"),
    refreshToken: req("GMAIL_REFRESH_TOKEN"),
    redirectUri: process.env.GMAIL_REDIRECT_URI?.trim() || "http://localhost:3000/oauth2callback",
  },
  supportEmail: process.env.SUPPORT_EMAIL?.trim() || "support@blinkfinances.com",
  pollCron: process.env.SUPPORT_POLL_CRON?.trim() || "*/1 * * * *",
  processing: {
    batchSize: parseInt(process.env.BATCH_SIZE ?? "25", 10),
    maxResultsPerPage: parseInt(process.env.MAX_RESULTS_PER_PAGE ?? "100", 10),
    rateLimitDelayMs: parseInt(process.env.RATE_LIMIT_DELAY_MS ?? "500", 10),
  },
};
