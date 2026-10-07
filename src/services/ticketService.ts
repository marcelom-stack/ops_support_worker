import { pool } from "../db/pool.js";
import { isSystemSender } from "../lib/normalizeEmail.js";
import type { ParsedEmail } from "./emailParser.js";

type OpenTicket = { id: string; status: string; ticket_number: string };

async function findOpenTicketForMember(
  userId: string | null,
  fromEmail: string | null,
): Promise<OpenTicket | null> {
  if (userId) {
    const byUser = await pool.query(
      `
      SELECT t.id, t.status, t.ticket_number
      FROM ops_support_tickets t
      JOIN ops_support_emails e ON e.id = t.email_id
      WHERE e.user_id = $1
        AND t.status IN ('open', 'in_progress')
      ORDER BY t.created_at ASC
      LIMIT 1
    `,
      [userId],
    );
    if (byUser.rows.length > 0) return byUser.rows[0] as OpenTicket;
  }

  if (fromEmail?.trim()) {
    const bySender = await pool.query(
      `
      SELECT t.id, t.status, t.ticket_number
      FROM ops_support_tickets t
      JOIN ops_support_emails e ON e.id = t.email_id
      WHERE lower(trim(e.from_email)) = lower(trim($1))
        AND e.user_id IS NULL
        AND t.status IN ('open', 'in_progress')
      ORDER BY t.created_at ASC
      LIMIT 1
    `,
      [fromEmail],
    );
    if (bySender.rows.length > 0) return bySender.rows[0] as OpenTicket;
  }

  return null;
}

async function linkEmailToOpenTicket(emailId: string, ticket: OpenTicket): Promise<void> {
  await pool.query(
    `
    UPDATE ops_support_emails
    SET ticket_id = $1, updated_at = NOW()
    WHERE id = $2
  `,
    [ticket.id, emailId],
  );

  if (ticket.status === "resolved" || ticket.status === "closed") {
    await pool.query(
      `
      UPDATE ops_support_tickets
      SET status = 'in_progress', resolved_at = NULL, updated_at = NOW()
      WHERE id = $1
    `,
      [ticket.id],
    );
    console.info(`[ticket] reopened ${ticket.ticket_number} (member activity)`);
  } else {
    await pool.query(`UPDATE ops_support_tickets SET updated_at = NOW() WHERE id = $1`, [ticket.id]);
    console.info(`[ticket] linked email to ${ticket.ticket_number} (same member, new thread)`);
  }
}

export async function createTicketFromEmail(
  emailId: string,
  priority: "urgent" | "high" | "medium" | "low" = "medium",
): Promise<{ id: string; ticket_number: string } | null> {
  const emailResult = await pool.query(
    `SELECT id, subject, snippet, body_text FROM ops_support_emails WHERE id = $1`,
    [emailId],
  );
  if (emailResult.rows.length === 0) return null;

  const email = emailResult.rows[0];
  const title = String(email.subject || "No Subject").slice(0, 255);
  const description = String(email.snippet || String(email.body_text ?? "").slice(0, 500) || "No description").slice(
    0,
    500,
  );

  const ticketNumberResult = await pool.query(`SELECT ops_support_next_ticket_number() AS ticket_number`);
  const ticketNumber = ticketNumberResult.rows[0].ticket_number as string;

  const ticketResult = await pool.query(
    `
    INSERT INTO ops_support_tickets (
      email_id, ticket_number, title, description, priority, status, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, 'open', NOW(), NOW())
    RETURNING id, ticket_number
  `,
    [emailId, ticketNumber, title, description, priority],
  );

  return ticketResult.rows[0] as { id: string; ticket_number: string };
}

export async function autoCreateTicketForEmail(
  emailId: string,
  parsed: ParsedEmail,
  supportEmail: string,
): Promise<void> {
  const emailCheck = await pool.query(
    `
    SELECT id, date_received, responded_to, from_email, direction, user_id
    FROM ops_support_emails WHERE id = $1
  `,
    [emailId],
  );
  if (emailCheck.rows.length === 0) return;

  const email = emailCheck.rows[0];
  if (email.direction === "outbound") return;

  const emailDate = email.date_received ? new Date(email.date_received) : null;
  const cutoff = new Date("2025-12-01");
  if (!emailDate || emailDate < cutoff) return;

  if (isSystemSender(email.from_email, supportEmail)) return;

  const existing = await pool.query(`SELECT id FROM ops_support_tickets WHERE email_id = $1`, [emailId]);
  if (existing.rows.length > 0) return;

  if (parsed.gmail_thread_id) {
    const threadTicket = await pool.query(
      `
      SELECT t.id, t.status, t.ticket_number
      FROM ops_support_tickets t
      JOIN ops_support_emails e ON e.id = t.email_id
      WHERE e.gmail_thread_id = $1
      ORDER BY e.date_received ASC NULLS LAST
      LIMIT 1
    `,
      [parsed.gmail_thread_id],
    );

    if (threadTicket.rows.length > 0) {
      const ticket = threadTicket.rows[0] as OpenTicket;
      if (ticket.status === "resolved" || ticket.status === "closed") {
        await pool.query(
          `
          UPDATE ops_support_tickets
          SET status = 'in_progress', resolved_at = NULL, updated_at = NOW()
          WHERE id = $1
        `,
          [ticket.id],
        );
        console.info(`[ticket] reopened ${ticket.ticket_number}`);
      } else {
        await pool.query(`UPDATE ops_support_tickets SET updated_at = NOW() WHERE id = $1`, [ticket.id]);
        console.info(`[ticket] updated ${ticket.ticket_number} (thread activity)`);
      }
      return;
    }
  }

  const memberTicket = await findOpenTicketForMember(
    (email.user_id as string | null) ?? null,
    (email.from_email as string | null) ?? null,
  );
  if (memberTicket) {
    await linkEmailToOpenTicket(emailId, memberTicket);
    return;
  }

  const created = await createTicketFromEmail(emailId, "medium");
  if (created) {
    console.info(`[ticket] created ${created.ticket_number}`);
  }
}
