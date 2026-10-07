import type { ParsedEmail, AttachmentMeta } from "./emailParser.js";
import { pool } from "../db/pool.js";

export async function emailExists(gmailMessageId: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM ops_support_emails WHERE gmail_message_id = $1 LIMIT 1`,
    [gmailMessageId],
  );
  return r.rowCount !== null && r.rowCount > 0;
}

export async function storeEmail(parsed: ParsedEmail): Promise<string> {
  const r = await pool.query(
    `
    INSERT INTO ops_support_emails (
      gmail_message_id, gmail_thread_id, from_email, from_name,
      to_email, cc_email, bcc_email, reply_to_email, subject,
      body_text, body_html, snippet,
      date_sent, date_received, internal_date,
      message_id, in_reply_to, references_header,
      label_ids, history_id, size_estimate, raw_email, direction,
      is_processed, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
      $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
      true, NOW()
    )
    ON CONFLICT (gmail_message_id) DO UPDATE SET
      gmail_thread_id = EXCLUDED.gmail_thread_id,
      from_email = EXCLUDED.from_email,
      from_name = EXCLUDED.from_name,
      subject = EXCLUDED.subject,
      body_text = EXCLUDED.body_text,
      body_html = EXCLUDED.body_html,
      snippet = EXCLUDED.snippet,
      date_sent = EXCLUDED.date_sent,
      date_received = EXCLUDED.date_received,
      direction = EXCLUDED.direction,
      updated_at = NOW()
    RETURNING id
  `,
    [
      parsed.gmail_message_id,
      parsed.gmail_thread_id,
      parsed.from_email,
      parsed.from_name,
      parsed.to_email,
      parsed.cc_email,
      parsed.bcc_email,
      parsed.reply_to_email,
      parsed.subject,
      parsed.body_text,
      parsed.body_html,
      parsed.snippet,
      parsed.date_sent,
      parsed.date_received,
      parsed.internal_date,
      parsed.message_id,
      parsed.in_reply_to,
      parsed.references_header,
      parsed.label_ids,
      parsed.history_id,
      parsed.size_estimate,
      parsed.raw_email,
      parsed.direction,
    ],
  );
  return r.rows[0].id as string;
}

export async function storeAttachments(emailId: string, attachments: AttachmentMeta[]): Promise<void> {
  for (const att of attachments) {
    if (!att.attachmentId) continue;
    try {
      await pool.query(
        `
        INSERT INTO ops_support_email_attachments (
          email_id, gmail_attachment_id, filename, mime_type, size_bytes, part_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
        [emailId, att.attachmentId, att.filename, att.mimeType, att.size, att.partId],
      );
    } catch {
      // ignore duplicate attachment rows on re-processing
    }
  }
}

export async function assignUserToEmail(
  emailId: string,
  userId: string,
  method: string,
  confidence: number,
): Promise<void> {
  await pool.query(
    `
    UPDATE ops_support_emails
    SET user_id = $1,
        user_match_method = $2,
        user_match_confidence = $3,
        user_matched_at = NOW(),
        updated_at = NOW()
    WHERE id = $4 AND user_id IS NULL
  `,
    [userId, method, confidence, emailId],
  );
}

export async function getLastInboundDate(): Promise<Date> {
  const r = await pool.query(`
    SELECT MAX(date_received) AS last_date
    FROM ops_support_emails
    WHERE direction = 'inbound' AND date_received IS NOT NULL
  `);
  const last = r.rows[0]?.last_date;
  if (last) return new Date(last);
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

export async function getLastOutboundDate(supportEmail: string): Promise<Date> {
  const r = await pool.query(
    `
    SELECT MAX(date_sent) AS last_date
    FROM ops_support_emails
    WHERE direction = 'outbound' AND lower(from_email) = lower($1) AND date_sent IS NOT NULL
  `,
    [supportEmail],
  );
  const last = r.rows[0]?.last_date;
  if (last) return new Date(last);
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

export async function filterNewMessageIds(messageIds: string[]): Promise<string[]> {
  if (messageIds.length === 0) return [];
  const r = await pool.query(
    `SELECT gmail_message_id FROM ops_support_emails WHERE gmail_message_id = ANY($1::text[])`,
    [messageIds],
  );
  const existing = new Set(r.rows.map((row) => row.gmail_message_id as string));
  return messageIds.filter((id) => !existing.has(id));
}
