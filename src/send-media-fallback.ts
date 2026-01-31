import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { FeishuConfig, FeishuSendResult } from "./types.js";
import { normalizeFeishuTarget } from "./targets.js";
import { getFeishuRuntime } from "./runtime.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import { sendViaWebhook, isQuotaError } from "./webhook.js";
import { uploadImageFeishu, sendMediaFeishu } from "./media.js";
import { uploadImageToHost } from "./image-host.js";
import path from "path";

/**
 * Send media (image/file) with webhook fallback on quota errors.
 * For images, uploads the image and sends via webhook if API fails.
 */
export async function sendMediaFeishuWithFallback(params: {
  cfg: ClawdbotConfig;
  to: string;
  mediaUrl: string;
}): Promise<FeishuSendResult> {
  const { cfg, to, mediaUrl } = params;
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  if (!feishuCfg) {
    throw new Error("Feishu channel not configured");
  }

  const chatId = normalizeFeishuTarget(to);
  if (!chatId) {
    throw new Error(`Invalid Feishu target: ${to}`);
  }

  // Try to send via API first
  try {
    return await sendMediaFeishu({ cfg, to, mediaUrl });
  } catch (error) {
    // Check if it's a quota error
    if (!isQuotaError(error)) {
      throw error;
    }

    // Try webhook fallback
    const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: chatId });
    const webhookUrl = groupConfig?.webhookUrl;

    if (!webhookUrl) {
      throw new Error(
        `Feishu API quota exceeded (${String(error)}). No webhook configured for fallback. ` +
        `Add webhookUrl to channels.feishu.groups["${chatId}"].webhookUrl in config.`
      );
    }

    const runtime = getFeishuRuntime();
    runtime.log?.(`feishu: API quota exceeded, falling back to webhook for media in ${chatId}`);
    console.log(`[feishu-media-fallback] Starting webhook fallback for mediaUrl: ${mediaUrl}`);

    // Check if it's an image (webhook only supports images, not files)
    const ext = path.extname(mediaUrl).toLowerCase();
    const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(ext);
    console.log(`[feishu-media-fallback] File extension: ${ext}, isImage: ${isImage}`);

    if (!isImage) {
      // For non-images, send URL as text
      runtime.log?.(`feishu: webhook doesn't support file type ${ext}, sending URL instead`);
      console.log(`[feishu-media-fallback] Non-image file, sending URL as text`);
      await sendViaWebhook({
        webhookUrl,
        text: `📎 ${mediaUrl}`,
        mentions: undefined,
      });

      return {
        messageId: "webhook-sent",
        chatId,
      };
    }

    // For images, download, upload and send via webhook
    try {
      console.log(`[feishu-media-fallback] Starting image download from: ${mediaUrl}`);
      runtime.log?.(`feishu: downloading image from ${mediaUrl}`);
      
      // Download image to buffer (same logic as sendMediaFeishu)
      let buffer: Buffer;
      const isLocalPath = mediaUrl.startsWith("/") || mediaUrl.startsWith("~") || /^[a-zA-Z]:/.test(mediaUrl);
      console.log(`[feishu-media-fallback] Is local path: ${isLocalPath}`);
      
      if (isLocalPath) {
        // Local file path
        console.log(`[feishu-media-fallback] Reading local file`);
        const fs = await import("fs");
        const filePath = mediaUrl.startsWith("~")
          ? mediaUrl.replace("~", process.env.HOME ?? "")
          : mediaUrl.replace("file://", "");
        
        console.log(`[feishu-media-fallback] Resolved file path: ${filePath}`);
        if (!fs.existsSync(filePath)) {
          throw new Error(`Local file not found: ${filePath}`);
        }
        buffer = fs.readFileSync(filePath);
        console.log(`[feishu-media-fallback] Local file read, buffer size: ${buffer.length} bytes`);
      } else {
        // Remote URL - fetch
        console.log(`[feishu-media-fallback] Fetching remote URL`);
        const response = await fetch(mediaUrl);
        console.log(`[feishu-media-fallback] Fetch response status: ${response.status}`);
        if (!response.ok) {
          throw new Error(`Failed to fetch image from URL: ${response.status}`);
        }
        buffer = Buffer.from(await response.arrayBuffer());
        console.log(`[feishu-media-fallback] Remote image downloaded, buffer size: ${buffer.length} bytes`);
      }
      
      // Try to upload to Feishu first
      console.log(`[feishu-media-fallback] Starting image upload to Feishu`);
      runtime.log?.(`feishu: uploading image for webhook fallback`);
      
      let imageUrl: string | null = null;
      
      try {
        const { imageKey } = await uploadImageFeishu({ cfg, image: buffer });
        console.log(`[feishu-media-fallback] Image uploaded to Feishu successfully, imageKey: ${imageKey}`);
        
        console.log(`[feishu-media-fallback] Sending image via webhook with imageKey`);
        runtime.log?.(`feishu: sending image via webhook with imageKey: ${imageKey}`);
        await sendViaWebhook({
          webhookUrl,
          text: "", // No text, just image
          mentions: undefined,
          imageKey,
        });
        console.log(`[feishu-media-fallback] Image sent successfully via webhook`);

        return {
          messageId: "webhook-sent",
          chatId,
        };
      } catch (uploadError) {
        // If Feishu upload fails, try image hosting service
        console.log(`[feishu-media-fallback] Feishu upload failed: ${String(uploadError)}`);
        
        const isQuotaErr = isQuotaError(uploadError);
        console.log(`[feishu-media-fallback] Is quota error: ${isQuotaErr}`);
        
        if (isQuotaErr) {
          // Try to upload to free image hosting service
          console.log(`[feishu-media-fallback] Trying to upload to image hosting service`);
          runtime.log?.(`feishu: Feishu upload hit quota limit, trying image hosting service`);
          
          try {
            const result = await uploadImageToHost(buffer);
            imageUrl = result.url;
            console.log(`[feishu-media-fallback] Image uploaded to hosting service: ${imageUrl}`);
            runtime.log?.(`feishu: image uploaded to hosting service: ${imageUrl}`);
          } catch (hostError) {
            console.log(`[feishu-media-fallback] Image hosting upload failed: ${String(hostError)}`);
            runtime.log?.(`feishu: image hosting upload failed: ${String(hostError)}`);
          }
        }
        
        // Send result via webhook
        let fallbackText: string;
        if (imageUrl) {
          // Successfully uploaded to image hosting
          fallbackText = `📷 图片链接：${imageUrl}`;
        } else if (isQuotaErr) {
          // Quota error but image hosting also failed
          fallbackText = `⚠️ 图片上传受限，暂时无法发送图片\n\n图片路径：${mediaUrl}`;
        } else {
          // Other error
          fallbackText = `📎 ${mediaUrl}`;
        }
        
        console.log(`[feishu-media-fallback] Sending fallback text via webhook`);
        await sendViaWebhook({
          webhookUrl,
          text: fallbackText,
          mentions: undefined,
        });

        return {
          messageId: "webhook-sent",
          chatId,
        };
      }
    } catch (outerError) {
      // Catch any other errors in the download/processing phase
      console.log(`[feishu-media-fallback] Outer error: ${String(outerError)}`);
      console.error(`[feishu-media-fallback] Full outer error:`, outerError);
      runtime.log?.(`feishu: image processing failed: ${String(outerError)}`);
      
      await sendViaWebhook({
        webhookUrl,
        text: `📎 ${mediaUrl}`,
        mentions: undefined,
      });

      return {
        messageId: "webhook-sent",
        chatId,
      };
    }
  }
}
