import cron from "node-cron";
import express from "express";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { runSupportSyncTick } from "./services/supportSync.js";

const app = express();

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
