"use client"

import { useAtom, useCreateAtom, useCreateStore } from "@tanstack/react-store";
import { useCallback, useRef, useMemo, useEffect } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import type { UploadFileArgs, UploadFileResult } from "@/hooks/community/mutations/uploads"
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
import {
  Composer,
  type ComposerHandle,
  type ComposerProps,
  type SendAttachment,
} from "./composer"
import type { Member } from "@/lib/community/models/people"
import {
  useUploadFile,
  zipUploadResultsWithDimensions,
  type UploadedAttachment,
} from "@/hooks/community/mutations/uploads"

// A forum post's body IS the first message in its thread — content plus any
// attachments and the audience-broadcast `mentionType` extracted from the body
// text. Tags are added AFTER creation from the post card's tag dialog, not here.
export type NewForumThread = {
  assertActive?: (() => void) & { signal: AbortSignal }
  nonce: string
  name: string
  content: string
  attachments?: UploadedAttachment[]
  mentionType?: MentionType
}

export function CreateForumThread({
  forumChannelId,
  members,
  mentionCandidates,
  onCancel,
  onCreatePost,
}: {
  // The parent forum channel's id — used as the upload target so R2 objects
  // live under the same access-scope as the post.
  forumChannelId: string
  members: Member[]
  mentionCandidates?: ComposerProps["mentionCandidates"]
  onCancel: () => void
  // Async — the page owns the mutation call + `enterThread` navigation. This
  // handler either resolves (success — child clears its state) or rejects
  // (failure — child toasts and preserves state for retry).
  onCreatePost: (post: NewForumThread) => Promise<void>
}) {
  const [title, setTitle] = useAtom(useCreateAtom(""))
  const [bodyHasContent, setBodyHasContent] = useAtom(useCreateAtom(false))
  const client = useQueryClient()
  const scopeId = useMemo(() => crypto.randomUUID(), [])
  const source = useCommunityViewSource(`forum-compose:${scopeId}`)
  const nonce = useCreateStore({ value: crypto.randomUUID() })
  const bodyComposerRef = useRef<ComposerHandle>(null)
  const uploadFile = useUploadFile({ gcTime: Infinity })
  const key = ["community", "forum-compose", scopeId]
  const canSubmit = title.trim().length > 0 && bodyHasContent
  const clearUploadReceipts = useCallback(() => {
    for (const mutation of client.getMutationCache().findAll({ mutationKey: ["community", "file-upload"], predicate: (mutation) => (mutation.state.variables as UploadFileArgs | undefined)?.receiptScope === scopeId })) client.getMutationCache().remove(mutation)
  }, [client, scopeId])
  useEffect(() => () => clearUploadReceipts(), [clearUploadReceipts])
  const command = useMutation({ meta: { observabilityAction: "forum.thread.create" }, mutationKey: key, gcTime: 0,
    mutationFn: async ({ markdown, title, attachments, mentionType, nonce, original }: { markdown: string; title: string; attachments: SendAttachment[]; mentionType?: MentionType; nonce: string; original: ReturnType<typeof source.capture> }) => {
      original()
      const results = await Promise.all(attachments.map(async (attachment) => {
        const cached = client.getMutationCache().findAll({ mutationKey: ["community", "file-upload"], status: "success", predicate: (mutation) => {
          const input = mutation.state.variables as UploadFileArgs | undefined
          return input?.receiptScope === scopeId && input.file === attachment.file && input.width === attachment.width && input.height === attachment.height && input.assertActive?.signal === original.signal
        } }).at(-1)?.state.data as UploadFileResult | undefined
        if (cached) return cached
        return uploadFile.mutateAsync({ target: { channelId: forumChannelId }, receiptScope: scopeId, assertActive: original, ...attachment })
      }))
      original()
      const uploaded = zipUploadResultsWithDimensions(results, attachments)
      await onCreatePost({ nonce, name: title, content: markdown, attachments: uploaded.length ? uploaded : undefined, mentionType, assertActive: original })
      return null
    },
    onSuccess: (_result, input) => {
      try { input.original() } catch { return }
      clearUploadReceipts()
      nonce.setState(() => ({ value: crypto.randomUUID() }))
      bodyComposerRef.current?.resetAfterSubmit()
      setTitle("")
    },
    onError: (error, input) => toastApiError(error, "Failed to create post", input.original),
  })
  const isSubmitting = command.isPending
  const onCancelGuarded = () => {
    if (client.getMutationCache().findAll({ mutationKey: key, status: "pending" }).length) return
    source.retire()
    onCancel()
  }
  const focusBody = () => bodyComposerRef.current?.focusEditor()
  const doSubmit = async (markdown: string, attachments: SendAttachment[] | undefined, mentionType: MentionType | undefined) => {
    if (!canSubmit || client.getMutationCache().findAll({ mutationKey: key, status: "pending" }).length) return
    const original = source.capture()
    original()
    try { await command.mutateAsync({ markdown, title: title.trim(), attachments: attachments ?? [], mentionType, nonce: nonce.get().value, original }) } catch {}
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
          onKeyDown={(event) => onEnterSubmit(focusBody, { onEscape: onCancelGuarded })(event)}
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
        sendContract="deferred"
        ref={bodyComposerRef}
        mode="forumThreadBody"
        hideEmoji
        hideAttach
        channel=""
        context="channel"
        members={members}
        mentionCandidates={mentionCandidates}
        channelRefCandidates={[]}
        placeholder="What do you want to discuss?"
        onDeferredSubmit={handleBodySubmit}
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
