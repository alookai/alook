import type {
  ChangeEventHandler,
  DragEventHandler,
  RefObject,
} from "react"
import { EditorContent, type Editor } from "@tiptap/react"
import { FileIcon, ImageIcon, PlusCircle, Smile, Upload, X } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import type { PendingFile } from "@/hooks/use-file-attachments"
import type { ChannelRefPopupState } from "@/lib/community/channel-ref-extension"
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
  replyingTo?: string
  onCancelReply?: () => void
  pendingFiles: PendingFile[]
  removePendingFile: (index: number) => void
  fileInputRef: RefObject<HTMLInputElement | null>
  onFileSelect: ChangeEventHandler<HTMLInputElement>
  editor: Editor | null
  hideAttach: boolean
  hideEmoji: boolean
  onAttachOpenChange: (open: boolean) => void
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
  replyingTo,
  onCancelReply,
  pendingFiles,
  removePendingFile,
  fileInputRef,
  onFileSelect,
  editor,
  hideAttach,
  hideEmoji,
  onAttachOpenChange,
  onUploadFile,
  onEmojiPick,
}: ComposerViewProps) {
  return (
    <div
      className={
        isForumThreadBody ? "relative" : "relative px-3 pb-3 pt-0"
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
      <ChannelRefList state={channelRefPopup} />

      {replyingTo && (
        <div className="flex items-center gap-2 rounded-t-xl border border-b-0 border-border/40 bg-muted/60 px-4 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            Replying to{" "}
            <span className="font-medium text-foreground">{replyingTo}</span>
          </span>
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
        className={`relative ${
          isForumThreadBody
            ? "bg-transparent ring-0"
            : "bg-muted shadow-(--e1) ring-1 ring-border/40 transition-shadow focus-within:ring-2 focus-within:ring-ring/60"
        } ${replyingTo || pendingFiles.length > 0 ? "rounded-b-xl" : "rounded-xl"}`}
      >
        {dragging && (
          <div
            className={`pointer-events-none absolute inset-0 z-10 grid place-items-center border-2 border-dashed border-ring bg-background/80 ${replyingTo || pendingFiles.length > 0 ? "rounded-b-xl" : "rounded-xl"}`}
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
          className={`chat-composer relative py-3 ${isForumThreadBody ? "px-2" : "px-12"}`}
          data-testid={tid.composerInput}
        >
          <EditorContent
            editor={editor}
            className={`${isForumThreadBody ? "max-h-60" : "max-h-40"} overflow-y-auto thin-scrollbar text-base chat-input-line-height outline-none`}
          />
        </div>
        {!hideAttach && (
          <DropdownMenu onOpenChange={onAttachOpenChange}>
            <DropdownMenuTrigger
              render={
                <button
                  data-testid={tid.composerAttach}
                  className="absolute left-2 bottom-2 grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
                  aria-label="Add"
                />
              }
            >
              <PlusCircle className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-44">
              <DropdownMenuItem onClick={onUploadFile}>
                <Upload className="size-4" /> Upload a File
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {!hideEmoji && (
          <EmojiPickerPopover side="top" align="end" onPick={onEmojiPick}>
            <button
              className="absolute right-2 bottom-2 grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
              aria-label="Emoji picker"
            >
              <Smile className="size-5" />
            </button>
          </EmojiPickerPopover>
        )}
      </div>
    </div>
  )
}

export function ComposerSkeleton() {
  return (
    <div className="relative px-3 pb-3 pt-0">
      <div className="relative rounded-xl bg-muted px-12 py-3 shadow-(--e1) ring-1 ring-border/40">
        <Skeleton className="h-5 w-2/5 rounded" />
        <Skeleton className="absolute left-2 bottom-2 size-8 rounded-full" />
        <Skeleton className="absolute right-2 bottom-2 size-8 rounded-full" />
      </div>
    </div>
  )
}
