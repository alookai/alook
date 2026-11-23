"use client"

import { toast } from "sonner"
import { ImageOff } from "@/components/icons/lucide"
import { RemoteContentImage } from "@/components/remote-image/remote-image"
import type { Attachment } from "@/lib/community/models/message"
import { useFileDownload } from "@/lib/file-download"
import { AttachmentContextMenu } from "./attachment-context-menu"
import { attachmentImageFrameStyle } from "./attachment-layout"

export function MessageImageAttachment({
  attachment,
  onOpen,
  onReady,
  testId,
  contextMenuDisabled,
}: {
  attachment: Extract<Attachment, { kind: "image" }>
  onOpen?: () => void
  onReady?: () => void
  testId: string
  contextMenuDisabled?: boolean
}) {
  const download = useFileDownload(attachment)

  return (
    <RemoteContentImage
      data-testid={testId}
      src={attachment.thumbnailUrl ?? attachment.url}
      alt={attachment.name}
      width={attachment.width}
      height={attachment.height}
      onActivate={onOpen}
      frameClassName="block max-w-full rounded-lg border border-border [--attachment-image-max-height:200px] transition-colors hover:border-primary/40 sm:[--attachment-image-max-height:240px]"
      frameStyle={attachmentImageFrameStyle(attachment.width, attachment.height)}
      imageClassName="block rounded-lg object-contain"
      errorLabel={<ImageOff role="img" aria-label="Image unavailable" className="size-7" />}
      onReady={onReady}
      renderFrame={(frame) => (
        <AttachmentContextMenu
          attachmentName={attachment.name}
          trigger={frame}
          onOpen={onOpen}
          onDownload={() => {
            void download.start((receipt) => {
              if (receipt.status === "error") toast.error("Couldn’t save this attachment")
            })
          }}
          downloading={download.state.status === "downloading"}
          disabled={contextMenuDisabled}
        />
      )}
    />
  )
}
