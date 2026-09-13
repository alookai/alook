import type {
  ChangeEventHandler,
  DragEventHandler,
  RefObject,
} from "react"
import { EditorContent, type Editor } from "@tiptap/react"
import {
  FileIcon,
  ImageIcon,
  PlusCircle,
  Smile,
  X,
} from "lucide-react"
import { stripInlineMarkup } from "@alook/shared"
import { Skeleton } from "@/components/ui/skeleton"
import type { PendingFile } from "@/hooks/use-file-attachments"
import type {
  ChannelRefCandidatePresentation,
  ChannelRefPopupState,
} from "@/lib/community/channel-ref-extension"
import type {
  MentionCandidatePresentation,
  MentionPopupState,
} from "@/lib/community/mention-extension"
import { tid } from "@/lib/community/testids"
import { EmojiPickerPopover } from "./emoji-picker"
import {
  ChannelRefList,
  CommunityMentionList,
} from "./composer-suggestion-popups"
import type { ComposerReplyTarget } from "./composer-types"
import { SendStrokeRoundedIcon } from "./send-stroke-rounded-icon"

const COMPOSER_OUTER_CLASS =
  "relative pl-[max(0.75rem,var(--app-safe-area-left))] pr-[max(0.75rem,var(--app-safe-area-right))] pb-[calc(0.75rem+var(--app-safe-area-bottom))] pt-0 sm:px-3 sm:pb-3"

export type ComposerViewProps = {
  isForumThreadBody: boolean
  dragging: boolean
  onDragEnter: DragEventHandler<HTMLDivElement>
  onDragLeave: DragEventHandler<HTMLDivElement>
  onDragOver: DragEventHandler<HTMLDivElement>
  onDrop: DragEventHandler<HTMLDivElement>
  mentionPopup: MentionPopupState
  mentionPresentation: MentionCandidatePresentation
  channelRefPopup: ChannelRefPopupState
  channelRefPresentation?: ChannelRefCandidatePresentation
  replyingTo?: ComposerReplyTarget
  onCancelReply?: () => void
  pendingFiles: PendingFile[]
  removePendingFile: (index: number) => void
  fileInputRef: RefObject<HTMLInputElement | null>
  onFileSelect: ChangeEventHandler<HTMLInputElement>
  editor: Editor | null
  hideAttach: boolean
  hideEmoji: boolean
  showSend: boolean
  sendDisabled: boolean
  onSend: () => void
  onUploadFile: () => void
  onEmojiPick: (emoji: string) => void
}

export function ComposerView({
  isForumThreadBody,
  dragging,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  mentionPopup,
  mentionPresentation,
  channelRefPopup,
  channelRefPresentation,
  replyingTo,
  onCancelReply,
  pendingFiles,
  removePendingFile,
  fileInputRef,
  onFileSelect,
  editor,
  hideAttach,
  hideEmoji,
  showSend,
  sendDisabled,
  onSend,
  onUploadFile,
  onEmojiPick,
}: ComposerViewProps) {
  const replyPreview = replyingTo
    ? stripInlineMarkup(replyingTo.text).replace(/\s+/g, " ").trim()
    : null

  const composerRadius = replyingTo || pendingFiles.length > 0
    ? showSend ? "rounded-b-[24px]" : "rounded-b-xl"
    : showSend ? "rounded-[24px]" : "rounded-xl"

  return (
    <div
      className={
        isForumThreadBody
          ? "relative"
          : COMPOSER_OUTER_CLASS
      }
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <CommunityMentionList
        state={mentionPopup}
        presentation={mentionPresentation}
      />
      <ChannelRefList
        state={channelRefPopup}
        presentation={channelRefPresentation}
      />

      {replyingTo && (
        <div className="flex items-center gap-2 rounded-t-xl border border-b-0 border-border/40 bg-muted/60 px-4 py-2 text-xs text-muted-foreground">
          <div
            data-slot="composer-reply-preview"
            className="min-w-0 flex-1 truncate"
          >
            Replying to{" "}
            <span className="font-medium text-foreground">
              {replyingTo.authorName}
            </span>
            <span aria-hidden="true"> · </span>
            <span className="text-foreground/70">{replyPreview}</span>
          </div>
          <button
            onClick={onCancelReply}
            className="ml-auto grid size-4 shrink-0 place-items-center rounded-full hover:bg-foreground/10 hover:text-foreground"
            aria-label="Cancel reply"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {pendingFiles.length > 0 && (
        <div
          className={`flex flex-wrap gap-2 border-x border-b border-border/40 bg-muted/40 px-4 py-2 ${replyingTo ? "" : "rounded-t-xl border-t"}`}
        >
          {pendingFiles.map((pendingFile, index) => {
            const isImage = pendingFile.file.type.startsWith("image/")
            return (
              <div
                key={index}
                className="group relative flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
              >
                {isImage ? (
                  <ImageIcon className="size-3.5 text-muted-foreground" />
                ) : (
                  <FileIcon className="size-3.5 text-muted-foreground" />
                )}
                <span className="max-w-30 truncate text-foreground">
                  {pendingFile.file.name}
                </span>
                <button
                  onClick={() => removePendingFile(index)}
                  className="grid size-4 shrink-0 place-items-center rounded-full hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Remove file"
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div
        data-slot="community-composer-base"
        className={`relative ${
          isForumThreadBody
            ? "bg-transparent ring-0"
            : "bg-muted shadow-(--e1) ring-1 ring-border/40 transition-shadow focus-within:ring-2 focus-within:ring-ring/60"
        } ${composerRadius}`}
      >
        {dragging && (
          <div
            className={`pointer-events-none absolute inset-0 z-10 grid place-items-center border-2 border-dashed border-ring bg-background/80 ${composerRadius}`}
          >
            <p className="text-sm font-medium text-muted-foreground">
              Drop files here
            </p>
          </div>
        )}
        <input
          data-testid={tid.composerFileInput}
          ref={fileInputRef}
          type="file"
          multiple
          onChange={onFileSelect}
          className="hidden"
        />
        <div
          className={`chat-composer relative py-3 ${
            isForumThreadBody
              ? "px-2"
              : "px-12"
          }`}
          data-testid={tid.composerInput}
        >
          <EditorContent
            editor={editor}
            className={`${isForumThreadBody ? "max-h-60" : "max-h-40"} overflow-y-auto thin-scrollbar text-base chat-input-line-height outline-none`}
          />
        </div>
        {!hideAttach && (
          <button
            type="button"
            data-testid={tid.composerAttach}
            className="absolute left-2 bottom-2 grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Add file"
            onClick={onUploadFile}
          >
            <PlusCircle className="size-5" />
          </button>
        )}
        {!hideEmoji && !showSend && (
          <EmojiPickerPopover side="top" align="end" onPick={onEmojiPick}>
            <button
              className="absolute right-2 bottom-2 grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
              aria-label="Emoji picker"
            >
              <Smile className="size-5" />
            </button>
          </EmojiPickerPopover>
        )}
        {showSend && (
          <button
            type="button"
            data-testid={tid.composerSend}
            className="absolute right-2 bottom-2 grid size-8 place-items-center rounded-full bg-primary text-primary-foreground enabled:hover:bg-primary/90 enabled:active:bg-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-transparent disabled:text-muted-foreground"
            aria-label="Send message"
            disabled={sendDisabled}
            onClick={onSend}
          >
            <SendStrokeRoundedIcon
              className="size-5 -translate-x-px translate-y-px"
            />
          </button>
        )}
      </div>
    </div>
  )
}

export function ComposerSkeleton() {
  return (
    <div className={COMPOSER_OUTER_CLASS}>
      <div className="relative rounded-xl [@media(hover:none)]:rounded-[24px] bg-muted py-3 px-12 shadow-(--e1) ring-1 ring-border/40">
        <Skeleton className="h-6 w-2/5 rounded" />
        <Skeleton className="absolute left-2 bottom-2 size-8 rounded-full" />
        <Skeleton className="absolute right-2 bottom-2 size-8 rounded-full" />
      </div>
    </div>
  )
}
