"use client"

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { FileIcon, ImageIcon, PlusCircle, Smile, Upload, Users, X } from "lucide-react"
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import { DOMParser as PMDOMParser } from "@tiptap/pm/model"
import { buildPasteDom } from "@/lib/community/paste-plain-text"
import { nextListScrollTop } from "@/lib/community/popup-scroll"
import { readComposerDraft, writeComposerDraft, clearComposerDraft } from "@/lib/community/composer-draft"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { useFileAttachments, type PendingFile } from "@/hooks/use-file-attachments"
import { MAX_ATTACHMENT_SIZE_BYTES } from "@alook/shared"
import { tid } from "@/lib/community/testids"
import { Avatar } from "./avatar"
import { ChannelIcon } from "./channel-icon"
import { EmojiPickerPopover } from "./emoji-picker"
import type { Member } from "./_types"
import type { MentionType } from "@alook/shared"
import {
  buildCommunityMentionExtension,
  detectMentionType,
  EMPTY_MENTION_STATE,
  rankMentionItems,
  type MentionContext,
  type MentionItem,
  type MentionPopupState,
} from "@/lib/community/mention-extension"
import {
  buildCommunityChannelRefExtension,
  EMPTY_CHANNEL_REF_STATE,
  rankChannelRefItems,
  toChannelRefCommandProps,
  type ChannelRefCandidate,
  type ChannelRefPopupState,
} from "@/lib/community/channel-ref-extension"

export type SendAttachment = {
  file: File
  thumbnailBlob?: Blob
  previewObjectUrl?: string
  width?: number
  height?: number
}

// Pure mapping from `useFileAttachments`'s pending-file state to `onSend`'s
// attachments argument. Extracted so the width/height threading through
// `Composer.send()` is unit-testable without mounting the tiptap editor.
export function pendingFilesToSendAttachments(pendingFiles: PendingFile[]): SendAttachment[] | undefined {
  if (pendingFiles.length === 0) return undefined
  return pendingFiles.map((pf) => ({
    file: pf.file,
    thumbnailBlob: pf.thumbnailBlob ?? undefined,
    previewObjectUrl: pf.thumbnailUrl ?? undefined,
    width: pf.width,
    height: pf.height,
  }))
}

// Pure extraction of the paste → File[] collection used by `handlePaste`:
// keep only clipboard items whose `kind === "file"` (a pasted image, or any
// dragged-in-then-copied file) and unwrap each via `getAsFile()`, dropping the
// occasional null the API returns. Extracted (like `pendingFilesToSendAttachments`)
// so the filtering is unit-testable without mounting the tiptap editor.
export function clipboardFiles(items: DataTransferItemList | undefined): File[] {
  if (!items) return []
  const files: File[] = []
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === "file") {
      const f = items[i].getAsFile()
      if (f) files.push(f)
    }
  }
  return files
}

type ComposerMode = "chat" | "forumThreadBody"

export type ComposerHandle = {
  focusEditor: () => void
  submitNow: () => void
  resetAfterSubmit: () => void
  isEmpty: () => boolean
  // Trigger the hidden file input's picker. Used by consumers that render
  // their own attach button outside the composer's absolute-positioned frame.
  openFilePicker: () => void
}

type ComposerBaseProps = {
  channel: string
  context: MentionContext
  members: Member[]
  // Fire-and-forget hook the composer calls with the current @-query on every
  // suggestion tick. Wired to `useServerMembers.searchMembers`, which debounces
  // and hits `/servers/:id/members/search`. Undefined for surfaces that don't
  // have a server roster (DM composer).
  onSearchMembers?: (query: string) => void
  // `/`-autocomplete candidates. Single-server list for channel/thread
  // composers; cross-server flattened list (via `useChannelRefDirectory()`)
  // for DM composers. Always provided by the caller — empty array is fine,
  // the popup just shows nothing on `/`.
  channelRefCandidates?: ChannelRefCandidate[]
  onChannelRefIntent?: () => void
  onTyping?: () => void
  // when set, shows a "Replying to X" bar above the input
  replyingTo?: string
  onCancelReply?: () => void
  // Auto-focus the editor on mount and on channel change. Desktop only —
  // callers pass `bp !== "mobile"` to avoid unexpected soft-keyboard pop-up.
  autoFocus?: boolean
  // `"chat"` (default) — Enter sends, Shift+Enter newline, `send()` clears.
  // `"forumThreadBody"` — inverted: Enter newline, Shift+Enter submits; `send()`
  // does NOT clear so the parent can await mutation success before resetting.
  mode?: ComposerMode
  // Placeholder override — used by `forumThreadBody` to swap the chat-composer
  // relic string. Falls back to the mode-derived default when absent.
  placeholder?: string
  // Hide the composer's built-in emoji-picker button (bottom-right). Used by
  // the create-post composer, where emoji is dropped from the compose surface.
  hideEmoji?: boolean
  // Hide the composer's built-in attach button (bottom-left). Used by the
  // create-post composer, which renders its own attach button in the footer
  // row and drives it through `ComposerHandle.openFilePicker()`.
  hideAttach?: boolean
  // Fires only on emptiness-state transitions (`hasContent` flips), not every
  // keystroke. Used by the create-post orchestrator to drive the footer button's
  // `disabled` state without mirroring editor content in parent React state.
  onDirty?: (hasContent: boolean) => void
  // When set, the composer persists its unsent text under this localStorage
  // scope (per channel/DM) and restores it on mount — the view remounts on
  // every channel switch (keyed by id), so this is what survives navigation.
  // Text only; attachments/replies are not cached. Omitted for forumThreadBody
  // (the parent owns that draft lifecycle).
  draftKey?: string
}

type ComposerAcceptedSend = {
  sendContract: "accepted"
  mode?: "chat"
  onAcceptSend: (markdown: string, attachments?: SendAttachment[], mentionType?: MentionType) => boolean
  onDeferredSubmit?: never
}

type ComposerDeferredSend = {
  sendContract: "deferred"
  mode: "forumThreadBody"
  onDeferredSubmit: (markdown: string, attachments?: SendAttachment[], mentionType?: MentionType) => void | Promise<void>
  onAcceptSend?: never
}

export type ComposerProps = ComposerBaseProps & (ComposerAcceptedSend | ComposerDeferredSend)

// Composer — plain-text TipTap editor with a chat-style @-mention popover.
// Users type raw markdown which MessageBody/Streamdown renders on display.
// In `mode="chat"` (default) Enter sends, Shift+Enter adds a newline. In
// `mode="forumThreadBody"` the mapping is inverted (Enter = newline,
// Shift+Enter = submit) to match /w's issue-sheet convention. While the
// mention popover is open Enter/Tab/Arrow keys drive selection instead.
// @everyone is a virtual candidate in channel + thread contexts
// (hidden in DM). (@here was removed — plans/remove-here-mention.md.)
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({
  channel,
  context,
  members,
  onSearchMembers,
  channelRefCandidates = [],
  onChannelRefIntent,
  sendContract,
  onAcceptSend,
  onDeferredSubmit,
  onTyping,
  replyingTo,
  onCancelReply,
  autoFocus = false,
  mode = "chat",
  placeholder,
  hideEmoji = false,
  hideAttach = false,
  onDirty,
  draftKey,
}, ref) {
  const isForumThreadBody = mode === "forumThreadBody"
  const {
    pendingFiles,
    setPendingFiles,
    transferPendingFiles,
    awaitPendingFiles,
    addPendingFiles,
    fileInputRef,
    handleFileSelect,
    removePendingFile,
    dragging,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop: handleDropRaw,
  } = useFileAttachments({
    maxFileSize: MAX_ATTACHMENT_SIZE_BYTES,
  })
  const typingTimer = useRef<NodeJS.Timeout | null>(null)
  const sendRef = useRef<() => void>(() => {})
  const sendInFlightRef = useRef<Promise<void> | null>(null)
  const lifecycleVersionRef = useRef(0)

  // Draft cache key, held in a ref so the editor's `onUpdate` closure (captured
  // once at build) always persists under the current scope. Restore is
  // suppressed via this flag so hydrating the editor doesn't fire `onTyping`.
  const draftKeyRef = useRef(draftKey)
  const sendScopeRef = useRef<string | null>(null)
  const sendScopeVersionRef = useRef(0)
  useLayoutEffect(() => {
    const nextScope = `${context}\u0000${channel}\u0000${draftKey ?? ""}`
    if (sendScopeRef.current !== nextScope) {
      sendScopeRef.current = nextScope
      sendScopeVersionRef.current++
    }
    draftKeyRef.current = draftKey
  }, [channel, context, draftKey])
  useLayoutEffect(() => () => { lifecycleVersionRef.current++ }, [])
  const restoringDraftRef = useRef(false)

  const [mentionPopup, setMentionPopup] = useState<MentionPopupState>(EMPTY_MENTION_STATE)
  const mentionPopupRef = useRef(mentionPopup)
  useEffect(() => { mentionPopupRef.current = mentionPopup }, [mentionPopup])

  const [channelRefPopup, setChannelRefPopup] = useState<ChannelRefPopupState>(EMPTY_CHANNEL_REF_STATE)
  const channelRefPopupRef = useRef(channelRefPopup)
  useEffect(() => { channelRefPopupRef.current = channelRefPopup }, [channelRefPopup])

  // The mention extension is built ONCE — its suggestion callbacks read refs
  // at runtime so live `members`/`context` updates are visible without
  // rebuilding the editor (which would reset its state).
  const membersRef = useRef(members)
  const contextRef = useRef(context)
  const onSearchMembersRef = useRef(onSearchMembers)
  // The most recent @-query the suggestion plugin passed us. Kept so the
  // re-rank effect below (fired when `members` changes while the popup is
  // open) can rank against the query the user actually sees.
  const queryRef = useRef<string>("")
  useEffect(() => { membersRef.current = members }, [members])
  useEffect(() => { contextRef.current = context }, [context])
  useEffect(() => { onSearchMembersRef.current = onSearchMembers }, [onSearchMembers])

  const fireTyping = () => {
    if (!onTyping || typingTimer.current) return
    onTyping()
    typingTimer.current = setTimeout(() => { typingTimer.current = null }, 3_000)
  }

  // eslint-disable-next-line react-hooks/refs -- refs read in runtime callbacks, not render
  const [mentionExtension] = useState(() =>
    buildCommunityMentionExtension({
      membersRef,
      contextRef,
      popupRef: mentionPopupRef,
      setPopup: setMentionPopup,
      onSearchMembersRef,
      queryRef,
    }),
  )

  // Same "built once, refs read at runtime" pattern as the mention extension.
  const channelRefCandidatesRef = useRef(channelRefCandidates)
  const onChannelRefIntentRef = useRef(onChannelRefIntent)
  const channelRefQueryRef = useRef<string>("")
  useEffect(() => { channelRefCandidatesRef.current = channelRefCandidates }, [channelRefCandidates])
  useEffect(() => { onChannelRefIntentRef.current = onChannelRefIntent }, [onChannelRefIntent])

  // eslint-disable-next-line react-hooks/refs -- refs read in runtime callbacks, not render
  const [channelRefExtension] = useState(() =>
    buildCommunityChannelRefExtension({
      candidatesRef: channelRefCandidatesRef,
      popupRef: channelRefPopupRef,
      onIntentRef: onChannelRefIntentRef,
      setPopup: setChannelRefPopup,
      queryRef: channelRefQueryRef,
    }),
  )

  // Re-rank + push a new popup state whenever `members` changes AND the popup
  // is open. Without this, tiptap's `suggestion.items` only fires on
  // caret/query updates — so remote-arrival changes to `members` (e.g. a
  // `useServerMembers.searchMembers` response landing) wouldn't reach the
  // popup until the user typed another character.
  //
  // Guard: bail unless the recomputed items differ from what's already
  // visible. React batches state updates through `Object.is`, but the popup
  // object identity always changes here (we rebuild it), so an unconditional
  // `setPopup` would fire on every `members` render — an infinite loop risk
  // if a downstream effect touches `members`.
  useEffect(() => {
    const cur = mentionPopupRef.current
    // Popup closed → nothing to reconcile.
    if (!cur.command) return
    const next = rankMentionItems(members, context, queryRef.current)
    if (itemsEqual(cur.items, next)) return
    // Preserve selectedIndex if it's still valid; otherwise reset to 0.
    setMentionPopup({
      ...cur,
      items: next,
      selectedIndex: cur.selectedIndex < next.length ? cur.selectedIndex : 0,
    })
  }, [members, context])

  // Same re-rank-on-candidates-change effect, mirrored for the channel-ref popup.
  useEffect(() => {
    const cur = channelRefPopupRef.current
    if (!cur.command) return
    const next = rankChannelRefItems(channelRefCandidates, channelRefQueryRef.current)
    if (channelRefItemsEqual(cur.items, next)) return
    setChannelRefPopup({
      ...cur,
      items: next,
      selectedIndex: cur.selectedIndex < next.length ? cur.selectedIndex : 0,
    })
  }, [channelRefCandidates])

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        codeBlock: false,
        code: false,
        blockquote: false,
        bold: false,
        italic: false,
        strike: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
      }),
      Placeholder.configure({ placeholder: placeholder ?? (context === "channel" ? `Message /${channel}` : `Message ${channel}`) }),
      mentionExtension,
      channelRefExtension,
    ],
    editorProps: {
      attributes: {
        class: "outline-none",
        enterkeyhint: isForumThreadBody ? "enter" : "send",
      },
      handleKeyDown: (_view, event) => {
        // editorProps.handleKeyDown runs BEFORE the suggestion plugin's keymap,
        // so when the mention popup is open we must NOT intercept Enter here —
        // otherwise we'd send the message instead of picking the highlighted
        // candidate. Returning false yields to ProseMirror's keymap chain, so
        // the suggestion plugin gets Enter/Arrow/Tab/Esc as designed.
        const mentionOpen =
          mentionPopupRef.current.items.length > 0 && mentionPopupRef.current.command !== null
        const channelRefOpen =
          channelRefPopupRef.current.items.length > 0 && channelRefPopupRef.current.command !== null
        if (mentionOpen || channelRefOpen) return false

        if (isForumThreadBody) {
          if (event.key === "Enter" && event.shiftKey && !event.isComposing) {
            event.preventDefault()
            sendRef.current()
            return true
          }
          return false
        }

        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault()
          sendRef.current()
          return true
        }
        return false
      },
      // Paste an image (or any file) from the clipboard → same pipeline as the
      // file picker / drag-drop: `addPendingFiles` (25MB + MIME + thumbnail).
      // Consume the event (`preventDefault` + `return true`) once files are
      // found so ProseMirror doesn't ALSO paste the image as text/HTML. Text-
      // only pastes return false and fall through to `clipboardTextParser`
      // below, which preserves both newline levels.
      handlePaste: (_view, event) => {
        const files = clipboardFiles(event.clipboardData?.items)
        if (files.length > 0) {
          event.preventDefault()
          addPendingFiles(files)
          return true
        }
        return false
      },
      // Preserve BOTH newline levels on paste: a blank line (`\n\n`) becomes a
      // paragraph break, a single `\n` becomes a hard line break — instead of
      // ProseMirror's default, which collapses any run of newlines to one
      // paragraph boundary (flattening a pasted multi-paragraph message). The
      // built DOM is handed to ProseMirror's own `DOMParser.parseSlice` so
      // slice open depths are computed by the library, not by hand.
      clipboardTextParser: (text, $context) => {
        const dom = buildPasteDom(text, document)
        return PMDOMParser.fromSchema($context.doc.type.schema).parseSlice(dom, {
          preserveWhitespace: true,
          context: $context,
        })
      },
    },
    onUpdate: ({ editor }) => {
      // Restore writes into the editor programmatically — don't treat that as
      // the user typing (would fire a spurious typing indicator + re-save).
      if (restoringDraftRef.current) return
      fireTyping()
      emitDirtyTransition()
      const key = draftKeyRef.current
      if (key && !isForumThreadBody) {
        // Persist the ProseMirror doc (JSON), not plain text — so @mention /
        // channel-ref pill nodes survive the round-trip and restore as pills,
        // not inert `@label` text.
        writeComposerDraft(key, editor.isEmpty ? null : editor.getJSON())
      }
    },
  })

  // Restore a cached draft on mount / when the scope key changes. The view
  // remounts on channel switch, so this fires once per composer instance for
  // the common case; the `draftKey` dep also covers a same-instance scope
  // change. Uses the paste pipeline so paragraph/hard-break structure round-
  // trips exactly like `getText({blockSeparator:"\n\n"})` serialized it.
  useEffect(() => {
    if (!editor || isForumThreadBody || !draftKey) return
    const doc = readComposerDraft(draftKey)
    if (!doc) return
    restoringDraftRef.current = true
    try {
      // Restore the stored ProseMirror doc directly — mention / channel-ref
      // pill nodes come back as pills (a plain-text restore would flatten them
      // to inert `@label` text). emitUpdate:false so the programmatic set isn't
      // treated as typing; errorOnInvalidContent:true so a stale/incompatible
      // doc throws into the catch below instead of silently blanking.
      editor.commands.setContent(doc as JSONContent, { emitUpdate: false, errorOnInvalidContent: true })
    } catch {
      // Corrupt/incompatible stored doc — drop it rather than crash the editor.
      clearComposerDraft(draftKey)
    } finally {
      restoringDraftRef.current = false
    }
    // Only re-run when the editor instance or scope key changes — not on every
    // render. Restoring is a mount-time (per-instance) concern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, draftKey])

  // Emitted-emptiness ref — used by the onDirty transition logic below to fire
  // only when the boolean flips. Initialized to false because the editor mounts
  // empty and no attachments exist yet.
  const prevHasContentRef = useRef<boolean>(false)
  const onDirtyRef = useRef(onDirty)
  useEffect(() => { onDirtyRef.current = onDirty }, [onDirty])
  const emitDirtyTransition = () => {
    if (!editor) return
    const next = !editor.isEmpty || pendingFiles.length > 0
    if (next === prevHasContentRef.current) return
    prevHasContentRef.current = next
    onDirtyRef.current?.(next)
  }
  // Attachment-side emptiness flips (drops, picker, removal) also feed onDirty.
  useEffect(() => {
    emitDirtyTransition()
    // emitDirtyTransition reads editor + pendingFiles by closure, so bind to
    // both. It's a stable inner closure — the dependency list is intentionally
    // the observed state, not the function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFiles, editor])

  const send = () => {
    if (!editor || sendInFlightRef.current) return
    const attemptScopeVersion = sendScopeVersionRef.current
    const attemptLifecycle = lifecycleVersionRef.current
    const attempt = (async () => {
      const preparedFiles = await awaitPendingFiles()
      if (
        lifecycleVersionRef.current !== attemptLifecycle ||
        sendScopeVersionRef.current !== attemptScopeVersion
      ) return
      if (editor.isEmpty && preparedFiles.length === 0) return
      // Block separator `\n\n` — paragraph breaks serialize as a markdown blank
      // line (a real paragraph), while in-paragraph hard breaks serialize as a
      // single `\n` (HardBreak's `renderText`). `remark-breaks` on render turns
      // the single `\n` into `<br>` and the blank line into a new paragraph, so
      // the compose → send → render round-trip preserves both newline levels.
      const markdown = editor.isEmpty ? "" : editor.getText({ blockSeparator: "\n\n" }).trim()
      const mentionType = detectMentionType(markdown)
      const attachments = pendingFilesToSendAttachments([...preparedFiles])
      if (sendContract === "accepted") {
        if (!onAcceptSend?.(markdown, attachments, mentionType)) return
      } else {
        await onDeferredSubmit?.(markdown, attachments, mentionType)
      }
      // In forumThreadBody mode the parent needs to await mutation success before
      // clearing — otherwise a failed create wipes the user's typed content.
      // Reset is delegated to the parent via `resetAfterSubmit()` on the ref.
      if (isForumThreadBody) return
      editor.commands.clearContent()
      if (draftKeyRef.current) clearComposerDraft(draftKeyRef.current)
      transferPendingFiles()
      setMentionPopup(EMPTY_MENTION_STATE)
      setChannelRefPopup(EMPTY_CHANNEL_REF_STATE)
    })()
    sendInFlightRef.current = attempt
    void attempt.then(() => {
      if (sendInFlightRef.current === attempt) sendInFlightRef.current = null
    }, () => {
      if (sendInFlightRef.current === attempt) sendInFlightRef.current = null
    })
  }

  useLayoutEffect(() => {
    sendRef.current = send
  })

  useImperativeHandle(ref, () => ({
    focusEditor: () => { editor?.commands.focus("end") },
    submitNow: () => {
      send()
    },
    resetAfterSubmit: () => {
      if (!editor) return
      editor.commands.clearContent()
      setPendingFiles([])
      setMentionPopup(EMPTY_MENTION_STATE)
      setChannelRefPopup(EMPTY_CHANNEL_REF_STATE)
    },
    isEmpty: () => !editor || (editor.isEmpty && pendingFiles.length === 0),
    openFilePicker: () => { fileInputRef.current?.click() },
  }))

  // Auto-focus on mount + on channel switch. `<Composer>` is not remounted
  // per channel (only `<MessageList>` is keyed by channelId), so keying this
  // effect on `channel` is what refocuses when the user navigates channels.
  // Skipped in forumThreadBody mode — the parent controls focus (starts on the
  // title, jumps to the body on Enter).
  useEffect(() => {
    if (!autoFocus || !editor || isForumThreadBody) return
    editor.commands.focus("end")
  }, [autoFocus, editor, channel, isForumThreadBody])

  // Focus the editor when a reply is initiated. Clicking "reply" on a message
  // sets `replyingTo` on the parent but doesn't touch the composer, so without
  // this the reply bar appears while focus stays on the message list — the user
  // has to click into the input before typing. Fire only on the unset→set edge
  // (clicking reply), not while a reply is already active or on cancel. Focus
  // regardless of `autoFocus`: reply is an explicit user action, so popping the
  // mobile keyboard is intended (same rationale as the drop handler below).
  const prevReplyingToRef = useRef(replyingTo)
  useEffect(() => {
    const opened = !prevReplyingToRef.current && !!replyingTo
    prevReplyingToRef.current = replyingTo
    if (opened && editor && !isForumThreadBody) editor.commands.focus("end")
  }, [replyingTo, editor, isForumThreadBody])

  // Refocus editor after a drop so the user can start typing without
  // clicking. The drop landed on the composer container — the intent is
  // clear.
  const handleDrop = (e: React.DragEvent) => {
    handleDropRaw(e)
    editor?.commands.focus()
  }

  return (
    <div
      className={isForumThreadBody ? "relative" : "relative px-3 pb-3 pt-0"}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <CommunityMentionList state={mentionPopup} />
      <ChannelRefList state={channelRefPopup} />

      {/* reply context bar — attached above the input */}
      {replyingTo && (
        <div className="flex items-center gap-2 rounded-t-xl border border-b-0 border-border/40 bg-muted/60 px-4 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">Replying to <span className="font-medium text-foreground">{replyingTo}</span></span>
          <button onClick={onCancelReply} className="ml-auto grid size-4 shrink-0 place-items-center rounded-full hover:bg-foreground/10 hover:text-foreground" aria-label="Cancel reply">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* pending attachments preview */}
      {pendingFiles.length > 0 && (
        <div className={`flex flex-wrap gap-2 border-x border-b border-border/40 bg-muted/40 px-4 py-2 ${replyingTo ? "" : "rounded-t-xl border-t"}`}>
          {pendingFiles.map((pf, i) => {
            const isImage = pf.file.type.startsWith("image/")
            return (
              <div key={i} className="group relative flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs">
                {isImage ? <ImageIcon className="size-3.5 text-muted-foreground" /> : <FileIcon className="size-3.5 text-muted-foreground" />}
                <span className="max-w-30 truncate text-foreground">{pf.file.name}</span>
                <button
                  onClick={() => removePendingFile(i)}
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

      <div className={`relative ${isForumThreadBody ? "bg-transparent ring-0" : "bg-muted shadow-(--e1) ring-1 ring-border/40 transition-shadow focus-within:ring-2 focus-within:ring-ring/60"} ${replyingTo || pendingFiles.length > 0 ? "rounded-b-xl" : "rounded-xl"}`}>
        {dragging && (
          <div
            className={`pointer-events-none absolute inset-0 z-10 grid place-items-center border-2 border-dashed border-ring bg-background/80 ${replyingTo || pendingFiles.length > 0 ? "rounded-b-xl" : "rounded-xl"}`}
          >
            <p className="text-sm font-medium text-muted-foreground">Drop files here</p>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />
        <div className={`chat-composer relative py-3 ${isForumThreadBody ? "px-2" : "px-12"}`} data-testid={tid.composerInput}>
          <EditorContent editor={editor} className={`${isForumThreadBody ? "max-h-60" : "max-h-40"} overflow-y-auto thin-scrollbar text-base chat-input-line-height outline-none`} />
        </div>
        {/* Attach button — fixed bottom-left */}
        {!hideAttach && (
          <DropdownMenu onOpenChange={(open) => { if (!open) editor?.commands.focus() }}>
            <DropdownMenuTrigger
              render={<button data-testid={tid.composerAttach} className="absolute left-2 bottom-2 grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground" aria-label="Add" />}
            >
              <PlusCircle className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-44">
              <DropdownMenuItem onClick={() => { fileInputRef.current?.click(); editor?.commands.focus() }}><Upload className="size-4" /> Upload a File</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/* Emoji button — fixed bottom-right */}
        {!hideEmoji && (
          <EmojiPickerPopover side="top" align="end" onPick={(e) => editor?.chain().focus().insertContent(e).run()}>
            <button className="absolute right-2 bottom-2 grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground" aria-label="Emoji picker">
              <Smile className="size-5" />
            </button>
          </EmojiPickerPopover>
        )}
      </div>
    </div>
  )
})

// Loading placeholder for <Composer>. Same outer footprint (px-3 pb-3 pt-0 +
// rounded surface) so the message list above stays anchored across channel
// switches and the input bar doesn't jump in.
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

// Structural equality on the popup's `items` array — used by the "members
// changed while popup is open" effect to skip no-op updates. Two lists are
// equal iff they have identical (kind,id,label) at each index; that's enough
// to catch the ranking-preserving cases (avatar/status flips get an update
// because the row visually differs). Guards against setPopup churn that
// would otherwise re-fire the effect via React's render loop.
function itemsEqual(a: MentionItem[], b: MentionItem[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.kind !== y.kind || x.id !== y.id || x.label !== y.label) return false
    if (x.kind === "member" && y.kind === "member") {
      if (x.avatar !== y.avatar || x.status !== y.status) return false
    }
  }
  return true
}

// Scroll the currently-highlighted row of a suggestion popover into view.
// Looks the row up by `aria-selected="true"` (not child index) — the mention
// list interleaves a "Members" section-header sibling, so an index lookup is
// off-by-one; the attribute is exact. Drives `scrollTop` directly (the popup is
// a fixed/transformed portal where `scrollIntoView` misbehaves). Row offsets
// are container-relative because the list container is `position:relative`.
function scrollSelectedRowIntoView(list: HTMLDivElement | null): void {
  if (!list) return
  const row = list.querySelector<HTMLElement>('[aria-selected="true"]')
  if (!row) return
  list.scrollTop = nextListScrollTop(
    list.scrollTop,
    list.clientHeight,
    row.offsetTop,
    row.offsetHeight,
  )
}

// Shared positioning for both suggestion popups (@-mention + /-ref). Both are
// fixed portals anchored to the caret rect. Horizontal: clamp so the 256px
// popup never runs off the right edge. Vertical: prefer above the caret (the
// default), but FLIP to below when there isn't room above — otherwise a caret
// near the top of the viewport (e.g. the create-post form) lifts the popup off
// the top edge. `POPUP_MAX_HEIGHT` mirrors the list's `max-h-60` (240px).
const POPUP_WIDTH = 256
const POPUP_MAX_HEIGHT = 240
const VIEWPORT_MARGIN = 8

export function popoverStyle(rect: DOMRect, viewportW: number, viewportH: number): React.CSSProperties {
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportW - POPUP_WIDTH - VIEWPORT_MARGIN)
  const left = Math.min(rect.left, maxLeft)

  const spaceAbove = rect.top
  const flipBelow = spaceAbove < POPUP_MAX_HEIGHT + VIEWPORT_MARGIN && rect.bottom + POPUP_MAX_HEIGHT + VIEWPORT_MARGIN <= viewportH
  return flipBelow
    ? { top: rect.bottom + 4, left }
    : { top: rect.top - 4, left, transform: "translateY(-100%)" }
}

function viewportSize(): { w: number; h: number } {
  if (typeof window === "undefined") return { w: POPUP_WIDTH, h: POPUP_MAX_HEIGHT }
  return { w: window.innerWidth, h: window.innerHeight }
}

// Portal-rendered popup. Anchored to the caret via clientRect() from
// @tiptap/suggestion (above by default, flips below near the viewport top —
// see `popoverStyle`). Highlighted row syncs to hover so keyboard + pointer agree.
function CommunityMentionList({ state }: { state: MentionPopupState }) {
  const listRef = useRef<HTMLDivElement>(null)
  const { items, selectedIndex, command, rect } = state

  useEffect(() => {
    scrollSelectedRowIntoView(listRef.current)
  }, [selectedIndex])

  if (!rect || items.length === 0 || !command) return null

  // Whether to show a "MEMBERS" section header above the first member row —
  // only when virtual (everyone/here) rows precede members.
  const firstMemberIdx = items.findIndex((it) => it.kind === "member")
  const hasVirtual = items.some((it) => it.kind !== "member")
  const showMembersHeader = hasVirtual && firstMemberIdx > 0

  const vp = viewportSize()

  return createPortal(
    <div
      className="fixed z-100 w-64 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--e2)"
      style={popoverStyle(rect, vp.w, vp.h)}
    >
      <div ref={listRef} className="relative max-h-60 overflow-x-hidden overflow-y-auto thin-scrollbar">
        {items.map((item, i) => {
          const selected = i === selectedIndex
          return (
            <MentionRow
              key={`${item.kind}:${item.id}`}
              item={item}
              selected={selected}
              showMembersHeader={showMembersHeader && i === firstMemberIdx}
              onSelect={() => command({ id: item.id, label: item.label })}
            />
          )
        })}
      </div>
    </div>,
    document.body,
  )
}

// Structural equality on the channel-ref popup's `items` array — same
// no-op-skip purpose as `itemsEqual` above.
function channelRefItemsEqual(a: ChannelRefCandidate[], b: ChannelRefCandidate[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].name !== b[i].name || a[i].serverId !== b[i].serverId) return false
  }
  return true
}

// Portal-rendered `/`-ref popup. Mirrors `CommunityMentionList` — anchored
// above the caret via clientRect(), highlighted row synced to hover.
function ChannelRefList({ state }: { state: ChannelRefPopupState }) {
  const listRef = useRef<HTMLDivElement>(null)
  const { items, selectedIndex, command, rect } = state

  useEffect(() => {
    scrollSelectedRowIntoView(listRef.current)
  }, [selectedIndex])

  if (!rect || items.length === 0 || !command) return null

  // The list spans multiple servers (the DM case) when any two candidates
  // differ on serverId — only then does each row show its "serverName /"
  // prefix, so same-server lists stay clean.
  const spansMultipleServers = items.some((it) => it.serverId !== items[0]?.serverId)

  const vp = viewportSize()

  return createPortal(
    <div
      className="fixed z-100 w-64 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--e2)"
      style={popoverStyle(rect, vp.w, vp.h)}
    >
      <div ref={listRef} className="relative max-h-60 overflow-x-hidden overflow-y-auto thin-scrollbar">
        {items.map((item, i) => (
          <ChannelRefRow
            key={item.id}
            item={item}
            selected={i === selectedIndex}
            showServerPrefix={spansMultipleServers}
            onSelect={() => command(toChannelRefCommandProps(item))}
          />
        ))}
      </div>
    </div>,
    document.body,
  )
}

function ChannelRefRow({ item, selected, showServerPrefix, onSelect }: {
  item: ChannelRefCandidate
  selected: boolean
  showServerPrefix: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={[
        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/50",
      ].join(" ")}
      onMouseDown={(e) => {
        // mousedown (not click) — same rationale as MentionRow.
        e.preventDefault()
        onSelect()
      }}
    >
      <ChannelIcon className="size-3.5 text-muted-foreground" />
      <span className="font-medium">
        {showServerPrefix && <span className="text-muted-foreground">{item.serverName} / </span>}
        {item.name}
      </span>
    </button>
  )
}

function MentionRow({ item, selected, showMembersHeader, onSelect }: {
  item: MentionItem
  selected: boolean
  showMembersHeader: boolean
  onSelect: () => void
}) {
  return (
    <>
      {showMembersHeader && (
        <div className="-mx-1 mt-1 border-t border-border/60 px-2 pt-2 pb-1 text-xs font-semibold text-muted-foreground">Members</div>
      )}
      <button
        type="button"
        role="option"
        data-testid={tid.mentionOption(item.id)}
        aria-selected={selected}
        className={[
          "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
          selected ? "bg-accent" : "hover:bg-accent/50",
        ].join(" ")}
        onMouseDown={(e) => {
          // mousedown (not click) so the editor doesn't blur first and lose
          // the suggestion plugin's caret tracking.
          e.preventDefault()
          onSelect()
        }}
      >
        {item.kind === "member" ? (
          <Avatar label={item.avatar} seed={item.userId} size={24} presence={item.status} ringColor="var(--popover)" />
        ) : (
          // Only `@everyone` remains as a virtual (non-member) item — `@here`
          // was removed (plans/remove-here-mention.md).
          <span className="grid size-6 place-items-center rounded-full bg-primary/15 text-primary">
            <Users className="size-3.5" />
          </span>
        )}
        <span className="font-medium">
          {item.kind === "member" ? (
            <>
              {item.name}
              <span className="ml-1 text-xs font-normal tracking-wide text-muted-foreground">
                #{item.discriminator}
              </span>
            </>
          ) : (
            `@${item.label}`
          )}
        </span>
        {item.kind !== "member" && (
          <span className="ml-auto text-xs text-muted-foreground">Notify everyone</span>
        )}
      </button>
    </>
  )
}
