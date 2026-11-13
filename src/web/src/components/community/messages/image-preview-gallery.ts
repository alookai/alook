import type { ImagePreview, ImagePreviewItem, Msg } from "@/lib/community/models/message"

export function withImageGallery(image: ImagePreview, messages: readonly Pick<Msg, "id" | "attachments">[]): ImagePreview {
  const images: ImagePreviewItem[] = messages.flatMap(message => (message.attachments ?? []).flatMap((attachment, index) =>
    attachment.kind === "image" ? [{ key: `${message.id}:${index}`, originalUrl: attachment.url,
      thumbnailUrl: attachment.thumbnailUrl, name: attachment.name, width: attachment.width, height: attachment.height }] : [],
  ))
  const selected = images.find(item => image.key ? item.key === image.key : item.originalUrl === image.originalUrl)
  return selected ? { ...selected, images } : image
}
