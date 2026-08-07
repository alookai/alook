"use client"

import { useCallback, useRef, useState } from "react"
import { PlusCircle, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { onEnterSubmit } from "@/lib/ime"
import { toastApiError } from "@/lib/api/client"
import { MAX_CHANNEL_NAME_LENGTH, type MentionType } from "@alook/shared"
import { Composer, type ComposerHandle, type SendAttachment } from "./composer"
import type { Member } from "./_types"
import {
  useUploadFile,
  zipUploadResultsWithDimensions,
  type UploadedAttachment,
} from "@/hooks/community/mutations/uploads"

// A forum post's body IS the first message in its thread — content plus any
// attachments and the audience-broadcast `mentionType` extracted from the body
// text. Tags are added AFTER creation from the post card's tag dialog, not here.
export type NewForumPost = {
  name: string
  content: string
  attachments?: UploadedAttachment[]
  mentionType?: MentionType
}

export function CreateForumPost({
  forumChannelId,
  members,
  onSearchMembers,
  onCancel,
  onCreatePost,
}: {
  // The parent forum channel's id — used as the upload target so R2 objects
  // live under the same access-scope as the post.
  forumChannelId: string
  members: Member[]
  onSearchMembers?: (query: string) => void
  onCancel: () => void
  // Async — the page owns the mutation call + `enterThread` navigation. This
  // handler either resolves (success — child clears its state) or rejects
  // (failure — child toasts and preserves state for retry).
  onCreatePost: (post: NewForumPost) => Promise<void>
}) {
  const [title, setTitle] = useState("")
  const [bodyHasContent, setBodyHasContent] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  // Ref-mirrored `isSubmitting` — the state-based flag is set asynchronously,
  // so a rapid second Shift+Enter (which fires the editor's keydown BEFORE
  // React commits `setIsSubmitting(true)`) sees a stale `false` and double-
  // submits. The button's own `disabled` attribute blocks click-based
  // double-submits, but keyboard submits go straight through the composer.
  const submittingRef = useRef(false)
  const bodyComposerRef = useRef<ComposerHandle>(null)
  const uploadFile = useUploadFile()

  // Retry cache: files already uploaded to R2 skip re-upload on retry after a
  // create failure. Mutation-only (ref, not state) — read inside the async
  // submit path. Cleared after a successful create.
  const uploadedCacheRef = useRef<Map<File, UploadedAttachment>>(new Map())

  const canSubmit = title.trim().length > 0 && bodyHasContent

  const onCancelGuarded = useCallback(() => {
    // Belt-and-suspenders: Escape mid-upload from ANY source (title, root,
    // composer body, footer button) is a no-op. Prevents orphaned R2 objects
    // and half-submitted posts.
    if (isSubmitting) return
    onCancel()
  }, [isSubmitting, onCancel])

  const focusBody = () => bodyComposerRef.current?.focusEditor()

  const doSubmit = async (markdown: string, attachments: SendAttachment[] | undefined, mentionType: MentionType | undefined) => {
    if (!canSubmit || submittingRef.current) return
    submittingRef.current = true
    setIsSubmitting(true)
    try {
      const pending = attachments ?? []
      let uploaded: UploadedAttachment[] = []
      if (pending.length > 0) {
        const results = await Promise.all(
          pending.map(async (att) => {
            const cached = uploadedCacheRef.current.get(att.file)
            if (cached) return cached
            const res = await uploadFile.mutateAsync({
              target: { channelId: forumChannelId },
              file: att.file,
            })
            uploadedCacheRef.current.set(att.file, res)
            return res
          }),
        )
        uploaded = zipUploadResultsWithDimensions(results, pending)
      }
      try {
        await onCreatePost({
          name: title.trim(),
          content: markdown,
          attachments: uploaded.length > 0 ? uploaded : undefined,
          mentionType,
        })
      } catch (e) {
        toastApiError(e, "Failed to create post")
        return
      }
      uploadedCacheRef.current.clear()
      bodyComposerRef.current?.resetAfterSubmit()
      setTitle("")
    } catch (e) {
      toastApiError(e, "Failed to upload attachment")
    } finally {
      submittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const handleBodySubmit = (markdown: string, attachments: SendAttachment[] | undefined, mentionType: MentionType | undefined) => {
    void doSubmit(markdown, attachments, mentionType)
  }

  return (
    <div
      role="region"
      aria-label="Create post"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation()
          onCancelGuarded()
        }
      }}
      className="flex w-full min-w-0 shrink-0 flex-col border-b border-border px-4 py-3"
    >
      <div className="flex items-center gap-2 px-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onEnterSubmit(focusBody, { onEscape: onCancelGuarded })}
          placeholder="New post"
          autoFocus
          maxLength={MAX_CHANNEL_NAME_LENGTH}
          className="w-full min-w-0 bg-transparent text-2xl font-semibold outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={onCancelGuarded}
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Cancel post"
        >
          <X className="size-5" />
        </button>
      </div>
      <Composer
        sendContract="legacy"
        ref={bodyComposerRef}
        mode="forumPostBody"
        hideEmoji
        hideAttach
        channel=""
        context="channel"
        members={members}
        onSearchMembers={onSearchMembers}
        channelRefCandidates={[]}
        placeholder="What do you want to discuss?"
        onSend={handleBodySubmit}
        onDirty={setBodyHasContent}
      />
      <div className="mt-2 flex items-center gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={(
              <button
                type="button"
                className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
                aria-label="Add"
              />
            )}
          >
            <PlusCircle className="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-44">
            <DropdownMenuItem onClick={() => bodyComposerRef.current?.openFilePicker()}>
              <Upload className="size-4" /> Upload a File
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>⇧</Kbd>
          <span>+</span>
          <Kbd>⏎</Kbd>
        </span>
        <Button
          size="sm"
          onClick={() => bodyComposerRef.current?.submitNow()}
          disabled={!canSubmit || isSubmitting}
        >
          {isSubmitting ? "Creating…" : "Create post"}
        </Button>
      </div>
    </div>
  )
}
