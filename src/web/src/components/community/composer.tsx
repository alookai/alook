"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { AtSign, FileIcon, ImageIcon, MessagesSquare, PlusCircle, Smile, Upload, Users, X } from "lucide-react"
import { useEditor, EditorContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "./avatar"
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

// Composer — plain-text TipTap editor with a chat-style @-mention popover.
// Users type raw markdown which MessageBody/Streamdown renders on display.
// Enter sends, Shift+Enter adds a newline; while the mention popover is open
// Enter/Tab/Arrow keys drive selection instead. @everyone / @here are virtual
// candidates in channel + thread contexts (hidden in DM).
export function Composer({ channel, context, members, onSearchMembers, onSend, onCreateThread, onTyping, replyingTo, onCancelReply }: {
  channel: string
  context: MentionContext
  members: Member[]
  // Fire-and-forget hook the composer calls with the current @-query on every
  // suggestion tick. Wired to `useServerMembers.searchMembers`, which debounces
  // and hits `/servers/:id/members/search`. Undefined for surfaces that don't
  // have a server roster (DM composer).
  onSearchMembers?: (query: string) => void
  onSend?: (markdown: string, attachments?: File[], mentionType?: MentionType) => void
  onCreateThread?: () => void
  onTyping?: () => void
  // when set, shows a "Replying to X" bar above the input
  replyingTo?: string
  onCancelReply?: () => void
}) {
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const typingTimer = useRef<NodeJS.Timeout | null>(null)

  const [mentionPopup, setMentionPopup] = useState<MentionPopupState>(EMPTY_MENTION_STATE)
  const mentionPopupRef = useRef(mentionPopup)
  useEffect(() => { mentionPopupRef.current = mentionPopup }, [mentionPopup])

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
        if (mentionOpen) return false

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
    onSend?.(markdown, pendingFiles.length > 0 ? pendingFiles : undefined, mentionType)
    editor.commands.clearContent()
    setPendingFiles([])
    setMentionPopup(EMPTY_MENTION_STATE)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) {
      setPendingFiles((prev) => [...prev, ...files])
    }
    e.target.value = "" // Reset input to allow same file selection again
  }

  const removeFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <div className="relative px-3 pb-3 pt-0">
      <CommunityMentionList state={mentionPopup} />

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
          {pendingFiles.map((file, i) => {
            const isImage = file.type.startsWith("image/")
            return (
              <div key={i} className="group relative flex items-center gap-2 rounded border border-border bg-background px-3 py-2 text-xs">
                {isImage ? <ImageIcon className="size-3.5 text-muted-foreground" /> : <FileIcon className="size-3.5 text-muted-foreground" />}
                <span className="max-w-30 truncate text-foreground">{file.name}</span>
                <button
                  onClick={() => removeFile(i)}
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
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,audio/*,.pdf,.txt,.zip"
          onChange={handleFileSelect}
          className="hidden"
        />
        <div className="chat-composer relative px-12 py-3">
          <EditorContent editor={editor} className="max-h-40 overflow-y-auto thin-scrollbar text-base chat-input-line-height outline-none" />
        </div>
        {/* Attach button — fixed bottom-left */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<button className="absolute left-2 bottom-2 grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground aria-expanded:text-foreground" aria-label="Add" />}
          >
            <PlusCircle className="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-44">
            <DropdownMenuItem onClick={() => fileInputRef.current?.click()}><Upload className="size-4" /> Upload a File</DropdownMenuItem>
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
      className="fixed z-100 w-64 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-(--e2)"
      style={{ top: rect.top - 4, left: clampedLeft, transform: "translateY(-100%)" }}
    >
      <div ref={listRef} className="max-h-60 overflow-y-auto thin-scrollbar py-1">
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

function MentionRow({ item, selected, showMembersHeader, onSelect }: {
  item: MentionItem
  selected: boolean
  showMembersHeader: boolean
  onSelect: () => void
}) {
  return (
    <>
      {showMembersHeader && (
        <div className="border-t border-border/60 px-3 pt-1.5 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Members</div>
      )}
      <button
        type="button"
        role="option"
        aria-selected={selected}
        className={[
          "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
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
