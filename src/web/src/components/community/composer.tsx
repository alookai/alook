"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { AtSign, FileIcon, ImageIcon, MessagesSquare, PlusCircle, Smile, Upload, Users, X } from "lucide-react"
import { useEditor, EditorContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { useFileAttachments } from "@/hooks/use-file-attachments"
import { ALLOWED_ATTACHMENT_MIME_PREFIXES, MAX_ATTACHMENT_SIZE_BYTES } from "@alook/shared"
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
  type ChannelRefCandidate,
  type ChannelRefPopupState,
} from "@/lib/community/channel-ref-extension"

// Composer — plain-text TipTap editor with a chat-style @-mention popover.
// Users type raw markdown which MessageBody/Streamdown renders on display.
// Enter sends, Shift+Enter adds a newline; while the mention popover is open
// Enter/Tab/Arrow keys drive selection instead. @everyone / @here are virtual
// candidates in channel + thread contexts (hidden in DM).
export function Composer({ channel, context, members, onSearchMembers, channelRefCandidates = [], onSend, onCreateThread, onTyping, replyingTo, onCancelReply, autoFocus = false }: {
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
  onSend?: (markdown: string, attachments?: File[], mentionType?: MentionType) => void
  onCreateThread?: () => void
  onTyping?: () => void
  // when set, shows a "Replying to X" bar above the input
  replyingTo?: string
  onCancelReply?: () => void
  // Auto-focus the editor on mount and on channel change. Desktop only —
  // callers pass `bp !== "mobile"` to avoid unexpected soft-keyboard pop-up.
  autoFocus?: boolean
}) {
  const {
    pendingFiles,
    setPendingFiles,
    fileInputRef,
    handleFileSelect,
    removePendingFile,
    dragging,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop: handleDropRaw,
  } = useFileAttachments({
    // Community server enforces both. Passing them here rejects oversized /
    // wrong-mime files at the drag-drop OR file-picker boundary so users
    // see a scoped toast instead of a generic 400 on send.
    maxFileSize: MAX_ATTACHMENT_SIZE_BYTES,
    allowedMimePrefixes: ALLOWED_ATTACHMENT_MIME_PREFIXES,
  })
  const typingTimer = useRef<NodeJS.Timeout | null>(null)

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
  const channelRefQueryRef = useRef<string>("")
  useEffect(() => { channelRefCandidatesRef.current = channelRefCandidates }, [channelRefCandidates])

  // eslint-disable-next-line react-hooks/refs -- refs read in runtime callbacks, not render
  const [channelRefExtension] = useState(() =>
    buildCommunityChannelRefExtension({
      candidatesRef: channelRefCandidatesRef,
      popupRef: channelRefPopupRef,
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
      Placeholder.configure({ placeholder: context === "channel" ? `Message /${channel}` : `Message ${channel}` }),
      mentionExtension,
      channelRefExtension,
    ],
    editorProps: {
      attributes: {
        class: "outline-none",
        enterkeyhint: "send",
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

        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault()
          send()
          return true
        }
        return false
      },
    },
    onUpdate: () => {
      fireTyping()
    },
  })

  const send = () => {
    if (!editor || (editor.isEmpty && pendingFiles.length === 0)) return
    const markdown = editor.isEmpty ? "" : editor.getText({ blockSeparator: "\n" }).trim()
    const mentionType = detectMentionType(markdown)
    const files = pendingFiles.length > 0 ? pendingFiles.map((pf) => pf.file) : undefined
    onSend?.(markdown, files, mentionType)
    editor.commands.clearContent()
    setPendingFiles([])
    setMentionPopup(EMPTY_MENTION_STATE)
    setChannelRefPopup(EMPTY_CHANNEL_REF_STATE)
  }

  // Auto-focus on mount + on channel switch. `<Composer>` is not remounted
  // per channel (only `<MessageList>` is keyed by channelId), so keying this
  // effect on `channel` is what refocuses when the user navigates channels.
  useEffect(() => {
    if (!autoFocus || !editor) return
    editor.commands.focus("end")
  }, [autoFocus, editor, channel])

  // Refocus editor after a drop so the user can start typing without
  // clicking. The drop landed on the composer container — the intent is
  // clear.
  const handleDrop = (e: React.DragEvent) => {
    handleDropRaw(e)
    editor?.commands.focus()
  }

  return (
    <div
      className="relative px-3 pb-3 pt-0"
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
          <span>Replying to <span className="font-medium text-foreground">{replyingTo}</span></span>
          <button onClick={onCancelReply} className="ml-auto grid size-4 place-items-center rounded-full hover:bg-foreground/10 hover:text-foreground" aria-label="Cancel reply">
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
              <div key={i} className="group relative flex items-center gap-2 rounded border border-border bg-background px-3 py-2 text-xs">
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

      <div className={`relative bg-muted shadow-(--e1) ring-1 ring-border/40 ${replyingTo || pendingFiles.length > 0 ? "rounded-b-xl" : "rounded-xl"}`}>
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
          // Mirror `ALLOWED_ATTACHMENT_MIME_PREFIXES` — the server-side
          // allowlist. Keep this list a superset of what the server takes:
          // browsers filter aggressively by extension, so `text/*` alone
          // won't offer `.md`/`.log`/`.json` in the picker. The MIME check
          // in `useFileAttachments` is authoritative; `accept` just biases
          // the picker.
          accept="image/*,video/*,audio/*,application/pdf,text/*,.md,.log,.json,.csv,.yaml,.yml,.ts,.tsx,.js,.jsx"
          onChange={handleFileSelect}
          className="hidden"
        />
        <div className="chat-composer relative px-12 py-3">
          <EditorContent editor={editor} className="max-h-40 overflow-y-auto thin-scrollbar text-base chat-input-line-height outline-none" />
        </div>
        {/* Attach button — fixed bottom-left */}
        <DropdownMenu onOpenChange={(open) => { if (!open) editor?.commands.focus() }}>
          <DropdownMenuTrigger
            render={<button className="absolute left-2 bottom-2 grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground aria-expanded:text-foreground" aria-label="Add" />}
          >
            <PlusCircle className="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-44">
            <DropdownMenuItem onClick={() => { fileInputRef.current?.click(); editor?.commands.focus() }}><Upload className="size-4" /> Upload a File</DropdownMenuItem>
            {context === "channel" && <DropdownMenuItem onClick={onCreateThread}><MessagesSquare className="size-4" /> Create Thread</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Emoji button — fixed bottom-right */}
        <EmojiPickerPopover side="top" align="end" onPick={(e) => editor?.chain().focus().insertContent(e).run()}>
          <button className="absolute right-2 bottom-2 grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground aria-expanded:text-foreground" aria-label="Emoji picker">
            <Smile className="size-5" />
          </button>
        </EmojiPickerPopover>
      </div>
    </div>
  )
}

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

// Portal-rendered popup. Anchored above the caret via clientRect() from
// @tiptap/suggestion. Highlighted row syncs to hover so keyboard + pointer agree.
function CommunityMentionList({ state }: { state: MentionPopupState }) {
  const listRef = useRef<HTMLDivElement>(null)
  const { items, selectedIndex, command, rect } = state

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  if (!rect || items.length === 0 || !command) return null

  const POPUP_WIDTH = 256
  const VIEWPORT_MARGIN = 8
  const maxLeft = typeof window !== "undefined"
    ? Math.max(VIEWPORT_MARGIN, window.innerWidth - POPUP_WIDTH - VIEWPORT_MARGIN)
    : rect.left
  const clampedLeft = Math.min(rect.left, maxLeft)

  // Whether to show a "MEMBERS" section header above the first member row —
  // only when virtual (everyone/here) rows precede members.
  const firstMemberIdx = items.findIndex((it) => it.kind === "member")
  const hasVirtual = items.some((it) => it.kind !== "member")
  const showMembersHeader = hasVirtual && firstMemberIdx > 0

  return createPortal(
    <div
      className="fixed z-100 w-64 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--e2)"
      style={{ top: rect.top - 4, left: clampedLeft, transform: "translateY(-100%)" }}
    >
      <div ref={listRef} className="max-h-60 overflow-x-hidden overflow-y-auto thin-scrollbar">
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
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  if (!rect || items.length === 0 || !command) return null

  const POPUP_WIDTH = 256
  const VIEWPORT_MARGIN = 8
  const maxLeft = typeof window !== "undefined"
    ? Math.max(VIEWPORT_MARGIN, window.innerWidth - POPUP_WIDTH - VIEWPORT_MARGIN)
    : rect.left
  const clampedLeft = Math.min(rect.left, maxLeft)

  // The list spans multiple servers (the DM case) when any two candidates
  // differ on serverId — only then does each row show its "serverName /"
  // prefix, so same-server lists stay clean.
  const spansMultipleServers = items.some((it) => it.serverId !== items[0]?.serverId)

  return createPortal(
    <div
      className="fixed z-100 w-64 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--e2)"
      style={{ top: rect.top - 4, left: clampedLeft, transform: "translateY(-100%)" }}
    >
      <div ref={listRef} className="max-h-60 overflow-x-hidden overflow-y-auto thin-scrollbar">
        {items.map((item, i) => (
          <ChannelRefRow
            key={item.id}
            item={item}
            selected={i === selectedIndex}
            showServerPrefix={spansMultipleServers}
            onSelect={() => command({ id: item.id, label: item.name, serverId: item.serverId })}
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
        <div className="-mx-1 mt-1 border-t border-border/60 px-2 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Members</div>
      )}
      <button
        type="button"
        role="option"
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
          <Avatar label={item.avatar} size={24} presence={item.status} />
        ) : (
          <span className="grid size-6 place-items-center rounded-full bg-primary/15 text-primary">
            {item.kind === "everyone" ? <Users className="size-3.5" /> : <AtSign className="size-3.5" />}
          </span>
        )}
        <span className="font-medium">
          {item.kind === "member" ? item.label : `@${item.label}`}
        </span>
        {item.kind !== "member" && (
          <span className="ml-auto text-xs text-muted-foreground">
            {item.kind === "everyone" ? "Notify everyone" : "Notify online"}
          </span>
        )}
      </button>
    </>
  )
}
