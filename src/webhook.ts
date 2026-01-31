import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent } from "./mention.js";

export type SendWebhookParams = {
  webhookUrl: string;
  text: string;
  mentions?: MentionTarget[];
};

export type WebhookResponse = {
  code: number;
  msg?: string;
  data?: unknown;
};

/**
 * Send message via Feishu webhook (fallback when API quota exceeded).
 * Webhook messages are always sent as interactive cards.
 */
export async function sendViaWebhook(params: SendWebhookParams): Promise<void> {
  const { webhookUrl, text, mentions } = params;

  let content = text;
  if (mentions && mentions.length > 0) {
    content = buildMentionedCardContent(mentions, text);
  }

  const payload = {
    msg_type: "interactive",
    card: {
      config: {
        wide_screen_mode: true,
      },
      elements: [
        {
          tag: "markdown",
          content,
        },
      ],
    },
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Webhook request failed: ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as WebhookResponse;

  if (result.code !== 0) {
    throw new Error(`Webhook send failed: ${result.msg || `code ${result.code}`}`);
  }
}

/**
 * Check if error is a quota/rate limit error that should trigger webhook fallback.
 */
export function isQuotaError(error: unknown): boolean {
  if (!error) return false;

  const errorStr = String(error);
  
  // HTTP 429 Too Many Requests
  if (errorStr.includes("429")) return true;
  
  // Feishu quota error code
  if (errorStr.includes("99991403")) return true;
  
  // Other rate limit indicators
  if (errorStr.toLowerCase().includes("quota") || 
      errorStr.toLowerCase().includes("rate limit")) {
    return true;
  }

  return false;
}
