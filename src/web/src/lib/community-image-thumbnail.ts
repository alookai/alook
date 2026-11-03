import { MAX_ATTACHMENT_THUMBNAIL_EDGE_PX, MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES } from "@alook/shared"

const QUALITIES = [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]

export type CommunityImagePreparation = { blob: Blob | null; width: number; height: number }
export type CommunityImageWorkerResult = { result: CommunityImagePreparation | null } | { error: string } | { unsupported: true }

export function requiresCommunityThumbnail(size: number, width: number, height: number) {
  return size > MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES || Math.max(width, height) > MAX_ATTACHMENT_THUMBNAIL_EDGE_PX
}

export async function renderCommunityThumbnail(
  width: number,
  height: number,
  frame: (width: number, height: number) => ((quality: number) => Promise<Blob | null>) | null,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const fitted = Math.min(1, MAX_ATTACHMENT_THUMBNAIL_EDGE_PX / Math.max(width, height))
  const fittedWidth = Math.round(width * fitted), fittedHeight = Math.round(height * fitted)
  for (let attempt = 0; attempt < 10; attempt++) {
    signal?.throwIfAborted()
    const scale = 0.85 ** attempt
    const encode = frame(Math.max(1, Math.round(fittedWidth * scale)), Math.max(1, Math.round(fittedHeight * scale)))
    if (!encode) return null
    for (const quality of QUALITIES) {
      signal?.throwIfAborted()
      const blob = await encode(quality)
      if (!blob) return null
      if (blob.size <= MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES) return blob
    }
  }
  return null
}
