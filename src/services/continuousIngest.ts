import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { extractAttachments, parseGmailMessage } from "./emailParser.js";
import { gmailService } from "./gmailService.js";
import {
  emailExists,
  filterNewMessageIds,
  getLastInboundDate,
  getLastOutboundDate,
  storeAttachments,
  storeEmail,
} from "./supportEmailStore.js";
import { autoCreateTicketForEmail } from "./ticketService.js";
import { matchEmailToBcaUser } from "./userMatcher.js";

/** Floor so we never miss the backlog while recovering from a stalled ingest. */
const BACKFILL_FLOOR = new Date("2026-09-01T00:00:00.000Z");

function gmailDateQuery(_since: Date): string {
  // Emergency recovery: always scan from BACKFILL_FLOOR, ignore last-inbound watermark.
  const y = BACKFILL_FLOOR.getUTCFullYear();
  const m = String(BACKFILL_FLOOR.getUTCMonth() + 1).padStart(2, "0");
  const d = String(BACKFILL_FLOOR.getUTCDate()).padStart(2, "0");
  return `after:${y}/${m}/${d}`;
}

async function processMessageBatch(
  messageIds: string[],
  supportEmail: string,
): Promise<{ stored: number; tickets: number }> {
  let stored = 0;
  let tickets = 0;

  const newIds = await filterNewMessageIds(messageIds);
  console.info(`[ingest] batch ids=${messageIds.length} new=${newIds.length}`);
  if (newIds.length === 0) return { stored, tickets };

  const messages = await gmailService.batchGetMessages(newIds);

  for (const gmailMessage of messages) {
    if (!gmailMessage.id) continue;
    try {
      if (await emailExists(gmailMessage.id)) continue;

      const parsed = parseGmailMessage(gmailMessage, supportEmail);
      const emailId = await storeEmail(parsed);
      stored++;

      const attachments = extractAttachments(gmailMessage.payload);
      if (attachments.length > 0) {
        await storeAttachments(emailId, attachments);
      }

      if (parsed.direction === "inbound") {
        await matchEmailToBcaUser(emailId, parsed);
        const beforeTickets = await pool.query(`SELECT COUNT(*)::int AS c FROM ops_support_tickets`);
        await autoCreateTicketForEmail(emailId, parsed, supportEmail);
        const afterTickets = await pool.query(`SELECT COUNT(*)::int AS c FROM ops_support_tickets`);
        if ((afterTickets.rows[0]?.c ?? 0) > (beforeTickets.rows[0]?.c ?? 0)) tickets++;
      }

      console.info(`[ingest] stored ${parsed.direction} — ${parsed.subject?.slice(0, 60) || "(no subject)"}`);
    } catch (err) {
      console.error(`[ingest] failed message ${gmailMessage.id}`, err);
    }
  }

  return { stored, tickets };
}

async function ingestLabel(options: {
  labelIds: string[];
  since: Date;
  extraQuery?: string;
  supportEmail: string;
}): Promise<number> {
  const since = new Date(options.since.getTime() - 60_000);
  const query = [gmailDateQuery(since), options.extraQuery].filter(Boolean).join(" ");
  console.info(`[ingest] query="${query}" labels=${JSON.stringify(options.labelIds)}`);
  let stored = 0;

  for await (const batch of gmailService.listMessages({
    labelIds: options.labelIds,
    query,
    maxResults: config.processing.maxResultsPerPage,
  })) {
    const ids = batch.messages.map((m) => m.id).filter((id): id is string => !!id);
    console.info(`[ingest] gmail page size=${ids.length}`);
    const result = await processMessageBatch(ids, options.supportEmail);
    stored += result.stored;
  }

  return stored;
}

export async function runContinuousIngest(): Promise<void> {
  const supportEmail = config.supportEmail;
  console.info(`[ingest] polling Gmail for ${supportEmail}`);

  const lastInbound = await getLastInboundDate();
  // Do NOT filter to INBOX — support mail is often archived/labeled and vanishes from INBOX.
  // Broad query: anything not sent by support@ since the backfill floor.
  const inboundStored = await ingestLabel({
    labelIds: [],
    since: lastInbound,
    extraQuery: `-from:${supportEmail} -in:chats`,
    supportEmail,
  });

  const lastOutbound = await getLastOutboundDate(supportEmail);
  const outboundStored = await ingestLabel({
    labelIds: ["SENT"],
    since: lastOutbound,
    extraQuery: `from:${supportEmail}`,
    supportEmail,
  });

  await pool.query(
    `
    UPDATE ops_support_gmail_sync_state
    SET last_synced_at = NOW(), last_error = NULL, updated_at = NOW()
    WHERE id = 1
  `,
  );

  console.info(`[ingest] done — inbound stored: ${inboundStored}, outbound stored: ${outboundStored}`);
}
