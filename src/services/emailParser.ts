import type { gmail_v1 } from "googleapis";

export interface ParsedEmail {
  gmail_message_id: string;
  gmail_thread_id: string;
  from_email: string | null;
  from_name: string | null;
  to_email: string[];
  cc_email: string[];
  bcc_email: string[];
  reply_to_email: string | null;
  subject: string;
  body_text: string | null;
  body_html: string | null;
  snippet: string;
  date_sent: Date | null;
  date_received: Date | null;
  internal_date: Date | null;
  message_id: string | null;
  in_reply_to: string | null;
  references_header: string[];
  label_ids: string[];
  history_id: string | null;
  size_estimate: number | null;
  raw_email: string | null;
  direction: "inbound" | "outbound";
}

export interface AttachmentMeta {
  partId: string;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  attachmentId: string | null;
}

function decodeBase64Url(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

function parseHeaders(headers: gmail_v1.Schema$MessagePartHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const name = h.name?.toLowerCase();
    if (!name || !h.value) continue;
    out[name] = h.value;
  }
  return out;
}

function parseEmailAddress(addressString: string | undefined): { name: string | null; email: string } | null {
  if (!addressString) return null;
  const match = addressString.match(/^(.+?)\s*<(.+?)>$|^(.+)$/);
  if (!match) return null;
  if (match[3]) return { name: null, email: match[3].trim() };
  return { name: match[1]?.trim() || null, email: match[2].trim() };
}

function parseEmailAddresses(addressesString: string | undefined): Array<{ name: string | null; email: string }> {
  if (!addressesString) return [];
  return addressesString
    .split(",")
    .map((a) => parseEmailAddress(a.trim()))
    .filter((a): a is { name: string | null; email: string } => a !== null);
}

function parseDate(dateString: string | undefined): Date | null {
  if (!dateString) return null;
  const d = new Date(dateString);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseBody(payload: gmail_v1.Schema$MessagePart | undefined): { text: string | null; html: string | null } {
  const result = { text: null as string | null, html: null as string | null };

  const walk = (part: gmail_v1.Schema$MessagePart | undefined) => {
    if (!part) return;
    if (part.body?.data) {
      const mime = part.mimeType?.toLowerCase() ?? "";
      const decoded = decodeBase64Url(part.body.data);
      if (mime === "text/plain" && !result.text) result.text = decoded;
      else if (mime === "text/html" && !result.html) result.html = decoded;
    }
    for (const child of part.parts ?? []) walk(child);
  };

  walk(payload);
  return result;
}

export function extractAttachments(payload: gmail_v1.Schema$MessagePart | undefined): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];

  const walk = (part: gmail_v1.Schema$MessagePart | undefined, partId = "0") => {
    if (!part) return;
    if (part.filename || part.body?.attachmentId) {
      attachments.push({
        partId,
        filename: part.filename ?? null,
        mimeType: part.mimeType ?? null,
        size: part.body?.size ?? null,
        attachmentId: part.body?.attachmentId ?? null,
      });
    }
    for (const [index, child] of (part.parts ?? []).entries()) {
      const childId = partId === "0" ? String(index) : `${partId}.${index}`;
      walk(child, childId);
    }
  };

  walk(payload);
  return attachments;
}

export function parseGmailMessage(
  gmailMessage: gmail_v1.Schema$Message,
  supportEmail: string,
): ParsedEmail {
  const headers = parseHeaders(gmailMessage.payload?.headers);
  const fromParsed = parseEmailAddress(headers.from);
  const toParsed = parseEmailAddresses(headers.to);
  const ccParsed = parseEmailAddresses(headers.cc);
  const bccParsed = parseEmailAddresses(headers.bcc);
  const replyToParsed = parseEmailAddress(headers["reply-to"]);
  const body = parseBody(gmailMessage.payload);

  const internalDate = gmailMessage.internalDate
    ? new Date(parseInt(gmailMessage.internalDate, 10))
    : null;
  const dateSent = parseDate(headers.date);
  const fromEmail = fromParsed?.email ?? null;
  const direction =
    fromEmail?.toLowerCase() === supportEmail.toLowerCase() ? "outbound" : "inbound";

  return {
    gmail_message_id: gmailMessage.id!,
    gmail_thread_id: gmailMessage.threadId!,
    from_email: fromEmail,
    from_name: fromParsed?.name ?? null,
    to_email: toParsed.map((e) => e.email),
    cc_email: ccParsed.map((e) => e.email),
    bcc_email: bccParsed.map((e) => e.email),
    reply_to_email: replyToParsed?.email ?? null,
    subject: headers.subject ?? "",
    body_text: body.text,
    body_html: body.html,
    snippet: gmailMessage.snippet ?? "",
    date_sent: dateSent,
    date_received: internalDate ?? dateSent,
    internal_date: internalDate,
    message_id: headers["message-id"] ?? null,
    in_reply_to: headers["in-reply-to"] ?? null,
    references_header: headers.references ? headers.references.split(/\s+/).filter(Boolean) : [],
    label_ids: gmailMessage.labelIds ?? [],
    history_id: gmailMessage.historyId ?? null,
    size_estimate: gmailMessage.sizeEstimate ?? null,
    raw_email: null,
    direction,
  };
}
