/**
 * Image hosting service for uploading images when Feishu API quota is exceeded.
 * Uses free image hosting services to bypass API limitations.
 */

export type ImageHostUploadResult = {
  url: string;
  deleteUrl?: string;
};

/**
 * Upload image to catbox.moe (free, anonymous, designed for file sharing)
 * This is the most reliable option as it's specifically designed for anonymous uploads
 */
async function uploadToCatbox(buffer: Buffer): Promise<ImageHostUploadResult> {
  const formData = new FormData();
  const blob = new Blob([buffer], { type: 'image/png' });
  formData.append('reqtype', 'fileupload');
  formData.append('fileToUpload', blob, 'image.png');
  
  const response = await fetch('https://catbox.moe/user/api.php', {
    method: 'POST',
    body: formData,
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`catbox upload failed: ${response.status} - ${text}`);
  }
  
  const url = await response.text();
  console.log(`[image-host] catbox response: ${url}`);
  
  // Catbox returns the URL directly as plain text
  if (url && url.startsWith('https://')) {
    return { url };
  } else {
    throw new Error(`catbox upload failed: invalid response - ${url}`);
  }
}

/**
 * Upload image to 0x0.st (free, anonymous, simple)
 */
async function uploadTo0x0(buffer: Buffer): Promise<ImageHostUploadResult> {
  const formData = new FormData();
  const blob = new Blob([buffer], { type: 'image/png' });
  formData.append('file', blob, 'image.png');
  
  const response = await fetch('https://0x0.st', {
    method: 'POST',
    body: formData,
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`0x0.st upload failed: ${response.status} - ${text}`);
  }
  
  const url = await response.text();
  console.log(`[image-host] 0x0.st response: ${url}`);
  
  // 0x0.st returns the URL directly as plain text
  if (url && url.trim().startsWith('https://')) {
    return { url: url.trim() };
  } else {
    throw new Error(`0x0.st upload failed: invalid response - ${url}`);
  }
}

/**
 * Upload image to a free image hosting service.
 * Tries multiple services in order until one succeeds.
 */
export async function uploadImageToHost(buffer: Buffer): Promise<ImageHostUploadResult> {
  const services = [
    { name: 'catbox', upload: uploadToCatbox },
    { name: '0x0.st', upload: uploadTo0x0 },
  ];
  
  let lastError: Error | null = null;
  
  for (const service of services) {
    try {
      console.log(`[image-host] Trying to upload to ${service.name}`);
      const result = await service.upload(buffer);
      console.log(`[image-host] Successfully uploaded to ${service.name}: ${result.url}`);
      return result;
    } catch (error) {
      console.log(`[image-host] Failed to upload to ${service.name}: ${String(error)}`);
      lastError = error as Error;
      // Continue to next service
    }
  }
  
  // All services failed
  throw new Error(`All image hosting services failed. Last error: ${lastError?.message}`);
}
