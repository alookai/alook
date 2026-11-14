export async function readCommunityImageDimensions(bytes: Uint8Array, contentType: string): Promise<{ width?: number; height?: number }> {
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(contentType)) return {};
  try {
    const { default: sharp } = await import("sharp");
    const { autoOrient: { width, height } } = await sharp(bytes, { failOn: "error" }).metadata();
    return width && height ? { width, height } : {};
  } catch { return {}; }
}
