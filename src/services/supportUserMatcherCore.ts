import type { Pool } from "pg";
import { normalizeEmailForMatching } from "../lib/normalizeEmail.js";

export interface EmailMatchInput {
  from_email?: string | null;
  reply_to_email?: string | null;
  from_name?: string | null;
  body_text?: string | null;
  subject?: string | null;
  gmail_thread_id?: string | null;
}

export interface MatchResult {
  userId: string;
  method: string;
  confidence: number;
}

const USER_ID_PATTERNS = [
  /\[User ID:\s*([a-f0-9-]{36})\]/i,
  /User ID:\s*([a-f0-9-]{36})/i,
  /user id:\s*([a-f0-9-]{36})/i,
  /UserID:\s*([a-f0-9-]{36})/i,
  /userid:\s*([a-f0-9-]{36})/i,
];

const YAHOO_FAMILY = new Set(["yahoo.com", "ymail.com", "rocketmail.com", "myyahoo.com", "aol.com"]);

function extractEmailsFromText(text: string): string[] {
  const found = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
  return [...new Set(found.map((e) => e.trim().toLowerCase()))];
}

function extractPhoneNumbers(text: string): string[] {
  const phoneRegex = /(\+?1[-.\\s]?)?\(?([0-9]{3})\)?[-.\\s]?([0-9]{3})[-.\\s]?([0-9]{4})/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = phoneRegex.exec(text)) !== null) {
    const normalized = match[0].replace(/\D/g, "");
    const phone =
      normalized.length === 11 && normalized[0] === "1" ? normalized.substring(1) : normalized;
    if (phone.length === 10) matches.push(phone);
  }
  return [...new Set(matches)];
}

function cleanExtractedName(raw: string): string {
  return raw.replace(/[^A-Za-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

function extractNames(fromName: string | null | undefined, bodyText: string): string[] {
  const names: string[] = [];
  if (fromName?.trim()) names.push(cleanExtractedName(fromName));
  const patterns = [
    /(?:my name is|i'm|i am|this is|name is|name:)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,3})/i,
    /(?:signed|sincerely|regards|thanks),?\s*([A-Za-z]+(?:\s+[A-Za-z]+){0,3})/i,
  ];
  for (const pattern of patterns) {
    const m = bodyText.match(pattern);
    if (m?.[1]) {
      const cleaned = cleanExtractedName(m[1]);
      if (cleaned) names.push(cleaned);
    }
  }
  return [...new Set(names.filter(Boolean))];
}

async function findUserByUuid(pool: Pool, userId: string): Promise<string | null> {
  const r = await pool.query(`SELECT id FROM users WHERE id = $1::uuid LIMIT 1`, [userId]);
  return (r.rows[0]?.id as string) ?? null;
}

async function findUserByEmailExact(pool: Pool, email: string): Promise<string | null> {
  const r = await pool.query(`SELECT id FROM users WHERE lower(trim(email)) = lower(trim($1)) LIMIT 1`, [email]);
  return (r.rows[0]?.id as string) ?? null;
}

async function findUserByEmailNormalized(pool: Pool, email: string): Promise<string | null> {
  const normalized = normalizeEmailForMatching(email);
  if (!normalized) return null;

  const r = await pool.query(
    `
    SELECT id FROM users
    WHERE (
      CASE
        WHEN lower(split_part(email, '@', 2)) IN ('gmail.com', 'googlemail.com') THEN
          replace(lower(split_part(email, '@', 1)), '.', '') = replace(split_part($1, '@', 1), '.', '')
          AND split_part(replace(lower(split_part(email, '@', 1)), '.', ''), '+', 1)
            = split_part(replace(split_part($1, '@', 1), '.', ''), '+', 1)
          AND lower(split_part(email, '@', 2)) IN ('gmail.com', 'googlemail.com')
        WHEN lower(split_part(email, '@', 2)) IN ('outlook.com', 'hotmail.com', 'live.com', 'msn.com') THEN
          replace(lower(split_part(email, '@', 1)), '.', '') = replace(split_part($1, '@', 1), '.', '')
          AND lower(split_part(email, '@', 2)) = split_part($1, '@', 2)
        WHEN lower(split_part(email, '@', 2)) = ANY($2::text[]) THEN
          split_part(replace(lower(split_part(email, '@', 1)), '.', ''), '+', 1)
            = split_part(replace(split_part($1, '@', 1), '.', ''), '+', 1)
        ELSE lower(trim(email)) = lower(trim($3))
      END
    )
    LIMIT 1
  `,
    [normalized, [...YAHOO_FAMILY], email],
  );
  return (r.rows[0]?.id as string) ?? null;
}

async function findUserByPhone(pool: Pool, phone10: string): Promise<string | null> {
  const r = await pool.query(
    `
    SELECT id FROM users
    WHERE phone_number IS NOT NULL
      AND right(regexp_replace(phone_number, '\\D', '', 'g'), 10) = $1
    LIMIT 1
  `,
    [phone10],
  );
  return (r.rows[0]?.id as string) ?? null;
}

async function findUserByNameAndDomain(
  pool: Pool,
  firstName: string,
  lastName: string,
  domain: string,
): Promise<string | null> {
  const r = await pool.query(
    `
    SELECT id FROM users
    WHERE upper(trim(first_name)) = upper(trim($1))
      AND upper(trim(last_name)) = upper(trim($2))
      AND lower(split_part(email, '@', 2)) = lower($3)
    LIMIT 2
  `,
    [firstName, lastName, domain],
  );
  if (r.rows.length === 1) return r.rows[0].id as string;
  return null;
}

async function findUserByUniqueFullName(pool: Pool, firstName: string, lastName: string): Promise<string | null> {
  const r = await pool.query(
    `
    SELECT id FROM users
    WHERE upper(trim(first_name)) = upper(trim($1))
      AND upper(trim(last_name)) = upper(trim($2))
    LIMIT 2
  `,
    [firstName, lastName],
  );
  if (r.rows.length === 1) return r.rows[0].id as string;
  return null;
}

async function findUserByLastNameAndAnyFirstName(
  pool: Pool,
  firstNames: string[],
  lastName: string,
): Promise<string | null> {
  for (const fn of firstNames) {
    const r = await pool.query(
      `
      SELECT id FROM users
      WHERE upper(trim(first_name)) = upper(trim($1))
        AND upper(trim(last_name)) = upper(trim($2))
      LIMIT 2
    `,
      [fn, lastName],
    );
    if (r.rows.length === 1) return r.rows[0].id as string;
  }
  return null;
}

async function findUserFromThread(pool: Pool, threadId: string): Promise<string | null> {
  const r = await pool.query(
    `
    SELECT user_id FROM ops_support_emails
    WHERE gmail_thread_id = $1 AND user_id IS NOT NULL
    ORDER BY date_received ASC NULLS LAST
    LIMIT 1
  `,
    [threadId],
  );
  return (r.rows[0]?.user_id as string) ?? null;
}

/** Run full BCA user matching cascade for one inbound email. */
export async function matchEmailToBcaUserCore(
  pool: Pool,
  input: EmailMatchInput,
): Promise<MatchResult | null> {
  const content = `${input.body_text ?? ""}\n${input.subject ?? ""}`;

  for (const pattern of USER_ID_PATTERNS) {
    const m = content.match(pattern);
    if (m?.[1]) {
      const uid = await findUserByUuid(pool, m[1]);
      if (uid) return { userId: uid, method: "user_id_in_content", confidence: 1.0 };
    }
  }

  for (const addr of [input.from_email, input.reply_to_email]) {
    if (!addr) continue;
    const exact = await findUserByEmailExact(pool, addr);
    if (exact) {
      return {
        userId: exact,
        method: addr === input.from_email ? "email" : "reply_to",
        confidence: 1.0,
      };
    }
    const normalized = await findUserByEmailNormalized(pool, addr);
    if (normalized) {
      return {
        userId: normalized,
        method: addr === input.from_email ? "email_normalized" : "reply_to_normalized",
        confidence: 0.98,
      };
    }
  }

  const bodyEmails = extractEmailsFromText(content).filter(
    (e) => e !== input.from_email?.toLowerCase() && e !== input.reply_to_email?.toLowerCase(),
  );
  for (const addr of bodyEmails) {
    const exact = await findUserByEmailExact(pool, addr);
    if (exact) return { userId: exact, method: "body_email", confidence: 0.92 };
    const normalized = await findUserByEmailNormalized(pool, addr);
    if (normalized) return { userId: normalized, method: "body_email_normalized", confidence: 0.9 };
  }

  if (input.gmail_thread_id) {
    const threadUid = await findUserFromThread(pool, input.gmail_thread_id);
    if (threadUid) return { userId: threadUid, method: "thread", confidence: 0.95 };
  }

  const names = extractNames(input.from_name, input.body_text ?? "");
  for (const name of names) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const firstName = parts[0];
    const lastName = parts[parts.length - 1];
    const domain = input.from_email?.split("@")[1];

    if (domain) {
      const byDomain = await findUserByNameAndDomain(pool, firstName, lastName, domain);
      if (byDomain) return { userId: byDomain, method: "name_and_email_domain", confidence: 0.75 };
    }

    const unique = await findUserByUniqueFullName(pool, firstName, lastName);
    if (unique) return { userId: unique, method: "name_unique", confidence: 0.72 };

    if (parts.length >= 3) {
      const middleNames = parts.slice(1, -1);
      const byMiddle = await findUserByLastNameAndAnyFirstName(pool, [...middleNames, firstName], lastName);
      if (byMiddle) return { userId: byMiddle, method: "name_middle_or_first", confidence: 0.7 };
    }
  }

  for (const phone of extractPhoneNumbers(content)) {
    const uid = await findUserByPhone(pool, phone);
    if (uid) return { userId: uid, method: "phone", confidence: 0.85 };
  }

  return null;
}
