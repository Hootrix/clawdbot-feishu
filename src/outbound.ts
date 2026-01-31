import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishuWithFallback, sendMediaFeishuWithFallback } from "./send.js";
import { sendMediaFeishu } from "./media.js";

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text }) => {
    const result = await sendMessageFeishuWithFallback({ cfg, to, text });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl }) => {
    // Send text first if provided
    if (text?.trim()) {
      await sendMessageFeishuWithFallback({ cfg, to, text });
    }

    // Upload and send media if URL provided
    if (mediaUrl) {
      try {
        const result = await sendMediaFeishuWithFallback({ cfg, to, mediaUrl });
        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishuWithFallback failed:`, err);
        // Final fallback to URL link if everything fails
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendMessageFeishuWithFallback({ cfg, to, text: fallbackText });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendMessageFeishuWithFallback({ cfg, to, text: text ?? "" });
    return { channel: "feishu", ...result };
  },
};
