import cron from "node-cron";
import express from "express";
import { google } from "googleapis";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { runSupportSyncTick } from "./services/supportSync.js";

const app = express();

app.get("/gmail-diagnostic", async (_req, res) => {
  try {
    const oauth2Client = new google.auth.OAuth2(
      config.gmail.clientId,
      config.gmail.clientSecret,
      config.gmail.redirectUri,
    );
    oauth2Client.setCredentials({ refresh_token: config.gmail.refreshToken });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const profile = await gmail.users.getProfile({ userId: "me" });
    const afterOct3 = await gmail.users.messages.list({
      userId: "me",
      q: "after:2026/10/03 -from:support@blinkfinances.com",
      maxResults: 5,
    });
    const inInbox = await gmail.users.messages.list({
      userId: "me",
      q: "after:2026/10/03 in:inbox",
      maxResults: 5,
    });
    const newer = await gmail.users.messages.list({
      userId: "me",
      q: "newer_than:4d -from:support@blinkfinances.com",
      maxResults: 5,
    });

    let newest: Record<string, unknown> | null = null;
    const firstId = afterOct3.data.messages?.[0]?.id ?? newer.data.messages?.[0]?.id;
    if (firstId) {
      const msg = await gmail.users.messages.get({ userId: "me", id: firstId, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
      const headers = Object.fromEntries((msg.data.payload?.headers ?? []).map((h) => [h.name ?? "", h.value ?? ""]));
      newest = {
        id: firstId,
        internalDate: msg.data.internalDate,
        internalDateIso: msg.data.internalDate ? new Date(Number(msg.data.internalDate)).toISOString() : null,
        from: headers.From ?? null,
        subject: headers.Subject ?? null,
        date: headers.Date ?? null,
        labelIds: msg.data.labelIds ?? [],
      };
    }

    res.json({
      ok: true,
      profile: {
        emailAddress: profile.data.emailAddress,
        messagesTotal: profile.data.messagesTotal,
        threadsTotal: profile.data.threadsTotal,
        historyId: profile.data.historyId,
      },
      after_2026_10_03: {
        resultSizeEstimate: afterOct3.data.resultSizeEstimate ?? 0,
        ids: (afterOct3.data.messages ?? []).map((m) => m.id),
      },
      after_2026_10_03_in_inbox: {
        resultSizeEstimate: inInbox.data.resultSizeEstimate ?? 0,
        ids: (inInbox.data.messages ?? []).map((m) => m.id),
      },
      newer_than_4d: {
        resultSizeEstimate: newer.data.resultSizeEstimate ?? 0,
        ids: (newer.data.messages ?? []).map((m) => m.id),
      },
      newest,
      refresh_token: "valid",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      ok: false,
      error: message,
      refresh_token: /invalid_grant/i.test(message) ? "INVALID_GRANT" : "UNKNOWN_ERROR",
    });
  }
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM ops_support_emails) AS emails,
        (SELECT COUNT(*)::int FROM ops_support_tickets) AS tickets
    `);
    res.json({
      status: "ok",
      service: "ops-support-worker",
      emails: counts.rows[0]?.emails ?? 0,
      tickets: counts.rows[0]?.tickets ?? 0,
    });
  } catch (err) {
    console.error("health check failed", err);
    res.status(503).json({ status: "error", service: "ops-support-worker" });
  }
});

let syncRunning = false;

async function tick(): Promise<void> {
  if (syncRunning) return;
  syncRunning = true;
  try {
    await runSupportSyncTick();
  } catch (err) {
    console.error("[ops-support-worker] sync failed", err);
    await pool.query(
      `UPDATE ops_support_gmail_sync_state SET last_error = $1, updated_at = NOW() WHERE id = 1`,
      [String(err)],
    );
  } finally {
    syncRunning = false;
  }
}

if (!cron.validate(config.pollCron)) {
  throw new Error(`Invalid SUPPORT_POLL_CRON: ${config.pollCron}`);
}

cron.schedule(config.pollCron, () => {
  void tick();
});

app.listen(config.port, () => {
  console.info(`ops-support-worker listening on :${config.port}`);
  void tick();
});
