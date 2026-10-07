import { pool } from "../db/pool.js";
import type { ParsedEmail } from "./emailParser.js";
import { assignUserToEmail } from "./supportEmailStore.js";
import { matchEmailToBcaUserCore } from "./supportUserMatcherCore.js";

export async function matchEmailToBcaUser(emailId: string, parsed: ParsedEmail): Promise<void> {
  const result = await matchEmailToBcaUserCore(pool, {
    from_email: parsed.from_email,
    reply_to_email: parsed.reply_to_email,
    from_name: parsed.from_name,
    body_text: parsed.body_text,
    subject: parsed.subject,
    gmail_thread_id: parsed.gmail_thread_id,
  });

  if (result) {
    await assignUserToEmail(emailId, result.userId, result.method, result.confidence);
  }
}

/** Re-match all currently unmatched inbound emails (worker maintenance). */
export async function rematchAllUnmatchedEmails(): Promise<{ matched: number; still_unmatched: number }> {
  const rows = await pool.query(
    `
    SELECT id, from_email, reply_to_email, from_name, body_text, subject, gmail_thread_id
    FROM ops_support_emails
    WHERE user_id IS NULL AND direction = 'inbound'
    ORDER BY date_received ASC NULLS LAST
  `,
  );

  let matched = 0;
  for (const row of rows.rows) {
    const result = await matchEmailToBcaUserCore(pool, row);
    if (result) {
      await assignUserToEmail(row.id, result.userId, result.method, result.confidence);
      matched++;
    }
  }

  const remaining = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ops_support_emails WHERE user_id IS NULL AND direction = 'inbound'`,
  );
  return { matched, still_unmatched: remaining.rows[0]?.n ?? 0 };
}
