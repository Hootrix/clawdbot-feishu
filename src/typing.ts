import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { FeishuConfig } from "./types.js";
import { createFeishuClient } from "./client.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import { sendViaWebhook, isQuotaError } from "./webhook.js";
import { normalizeFeishuTarget } from "./targets.js";

// Feishu emoji types for typing indicator
// See: https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
// Full list: https://github.com/go-lark/lark/blob/main/emoji.go
const TYPING_EMOJI = "Typing"; // Typing indicator emoji

// Track which messages have already had typing indicator sent (to prevent duplicates)
const sentTypingIndicators = new Set<string>();

export type TypingIndicatorState = {
  messageId: string;
  reactionId: string | null;
  usedWebhook?: boolean; // Track if webhook was used
};

/**
 * Add a typing indicator (reaction) to a message.
 * If API fails with quota error, fallback to webhook to send "👀" emoji.
 */
export async function addTypingIndicator(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  chatId?: string; // Need chatId for webhook fallback
}): Promise<TypingIndicatorState> {
  const { cfg, messageId, chatId } = params;
  
  // Check if we've already sent typing indicator for this message
  if (sentTypingIndicators.has(messageId)) {
    console.log(`[feishu] typing indicator already sent for message ${messageId}, skipping`);
    return { messageId, reactionId: null };
  }
  
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  if (!feishuCfg) {
    return { messageId, reactionId: null };
  }

  const client = createFeishuClient(feishuCfg);

  try {
    console.log(`[feishu] attempting to add typing indicator for message ${messageId}`);
    const response = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: { emoji_type: TYPING_EMOJI },
      },
    });

    const reactionId = (response as any)?.data?.reaction_id ?? null;
    console.log(`[feishu] typing indicator added successfully`);
    sentTypingIndicators.add(messageId); // Mark as sent
    return { messageId, reactionId };
  } catch (err) {
    // If quota error and webhook is configured, send emoji via webhook
    if (isQuotaError(err) && chatId) {
      console.log(`[feishu] API quota error detected, checking webhook fallback for chatId: ${chatId}`);
      const normalizedChatId = normalizeFeishuTarget(chatId);
      if (normalizedChatId) {
        const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: normalizedChatId });
        const webhookUrl = groupConfig?.webhookUrl;
        
        if (webhookUrl) {
          try {
            console.log(`[feishu] sending ack emoji via webhook fallback`);
            await sendViaWebhook({
              webhookUrl,
              text: "👀",
              mentions: undefined,
            });
            console.log(`[feishu] ack emoji sent successfully via webhook`);
            sentTypingIndicators.add(messageId); // Mark as sent
            return { messageId, reactionId: null, usedWebhook: true };
          } catch (webhookErr) {
            console.log(`[feishu] webhook fallback for typing indicator failed: ${webhookErr}`);
          }
        } else {
          console.log(`[feishu] no webhook configured for fallback`);
        }
      }
    }
    
    // Silently fail - typing indicator is not critical
    console.log(`[feishu] failed to add typing indicator: ${err}`);
    return { messageId, reactionId: null };
  }
}

/**
 * Remove a typing indicator (reaction) from a message
 */
export async function removeTypingIndicator(params: {
  cfg: ClawdbotConfig;
  state: TypingIndicatorState;
}): Promise<void> {
  const { cfg, state } = params;
  if (!state.reactionId) return;

  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  if (!feishuCfg) return;

  const client = createFeishuClient(feishuCfg);

  try {
    await client.im.messageReaction.delete({
      path: {
        message_id: state.messageId,
        reaction_id: state.reactionId,
      },
    });
  } catch (err) {
    // Silently fail - cleanup is not critical
    console.log(`[feishu] failed to remove typing indicator: ${err}`);
  }
}
