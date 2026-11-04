"use client"

import { useRef, type ReactNode } from "react"
import { ComposerView } from "./composer-view"
import { EMPTY_MENTION_STATE } from "@/lib/community/mention-extension"
import { EMPTY_CHANNEL_REF_STATE } from "@/lib/community/channel-ref-extension"

const ignore = () => {}

export function ComposerPreview({ children, hasText = false }: { children?: ReactNode; hasText?: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null)
  return (
    <ComposerView
      isForumThreadBody={false}
      dragging={false}
      onDragEnter={ignore}
      onDragLeave={ignore}
      onDragOver={ignore}
      onDrop={ignore}
      mentionPopup={EMPTY_MENTION_STATE}
      mentionPresentation={{ status: "ready" }}
      channelRefPopup={EMPTY_CHANNEL_REF_STATE}
      pendingFiles={[]}
      removePendingFile={ignore}
      fileInputRef={fileInput}
      onFileSelect={ignore}
      editor={null}
      hideAttach={false}
      hideEmoji={false}
      showSend={hasText}
      sendDisabled={!hasText}
      onSend={ignore}
      onUploadFile={ignore}
      onEmojiPick={ignore}
      editorContent={children ?? <div className="min-h-6 text-base chat-input-line-height"><span className="text-muted-foreground">Message /general</span></div>}
    />
  )
}
