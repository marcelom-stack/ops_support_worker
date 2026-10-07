import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { config } from "../config.js";

class GmailService {
  private oAuth2Client;
  private gmail: gmail_v1.Gmail;

  constructor() {
    this.oAuth2Client = new google.auth.OAuth2(
      config.gmail.clientId,
      config.gmail.clientSecret,
      config.gmail.redirectUri,
    );
    this.oAuth2Client.setCredentials({ refresh_token: config.gmail.refreshToken });
    this.gmail = google.gmail({ version: "v1", auth: this.oAuth2Client });
  }

  async *listMessages(options: {
    query?: string;
    labelIds?: string[];
    maxResults?: number;
  }): AsyncGenerator<{ messages: gmail_v1.Schema$Message[]; nextPageToken?: string | null }> {
    let pageToken: string | undefined;

    do {
      const params: gmail_v1.Params$Resource$Users$Messages$List = {
        userId: "me",
        maxResults: options.maxResults ?? config.processing.maxResultsPerPage,
        q: options.query,
        pageToken,
        includeSpamTrash: false,
      };

      // Only apply label filter when explicitly provided and non-empty.
      // Empty array = search all mail matching `q` (needed after archive).
      if (options.labelIds && options.labelIds.length > 0) {
        params.labelIds = options.labelIds;
      }

      const response = await this.gmail.users.messages.list(params);

      const messages = response.data.messages ?? [];
      if (messages.length === 0) break;

      yield { messages, nextPageToken: response.data.nextPageToken };

      pageToken = response.data.nextPageToken ?? undefined;
      if (pageToken) await this.delay(config.processing.rateLimitDelayMs);
    } while (pageToken);
  }

  async getMessage(messageId: string): Promise<gmail_v1.Schema$Message> {
    const response = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    return response.data;
  }

  async batchGetMessages(messageIds: string[]): Promise<gmail_v1.Schema$Message[]> {
    const batchSize = config.processing.batchSize;
    const results: gmail_v1.Schema$Message[] = [];

    for (let i = 0; i < messageIds.length; i += batchSize) {
      const batch = messageIds.slice(i, i + batchSize);
      const fetched = await Promise.all(batch.map((id) => this.getMessage(id)));
      results.push(...fetched);
      if (i + batchSize < messageIds.length) {
        await this.delay(config.processing.rateLimitDelayMs);
      }
    }

    return results;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const gmailService = new GmailService();
