const INLINE_ATTACHMENT_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
])

export function isInlineAttachmentContentType(contentType: string | null | undefined): boolean {
  return contentType != null && INLINE_ATTACHMENT_CONTENT_TYPES.has(contentType.toLowerCase())
}
