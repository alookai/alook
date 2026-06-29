"use client"

import { useRef, useState } from "react"
import { PlusCircle, Smile, Upload, MessagesSquare, X, FileIcon, ImageIcon } from "lucide-react"
import { useEditor, EditorContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import { Markdown as ChatMarkdown } from "@tiptap/markdown"
import { decodeChatEntities } from "@/lib/chat-markdown"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Avatar } from "./avatar"
import { EmojiPickerPopover } from "./emoji-picker"
import type { Friend } from "./_types"

// Composer — TipTap rich-text input, same stack Alook's agent-chat composer uses
// (useEditor + StarterKit + Placeholder + @tiptap/markdown). Markdown shortcuts
// (**bold**, `code`, > quote…) work as you type. A lightweight @mention dropdown
// reads the editor's trailing token; `members` is the autocomplete source. The "+"
// opens an attach/thread menu (Upload a File / Create Thread only).
export function Composer({ channel, thread, members, onSend, onCreateThread, onTyping, replyingTo, onCancelReply }: {
  channel: string
  thread?: boolean
  members: Friend[]
  onSend?: (markdown: string, attachments?: File[]) => void
  onCreateThread?: () => void
  onTyping?: () => void
  // when set, shows a "Replying to X" bar above the input
  replyingTo?: string
  onCancelReply?: () => void
}) {
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const typingTimer = useRef<NodeJS.Timeout | null>(null)

  const fireTyping = () => {
    if (!onTyping || typingTimer.current) return
    onTyping()
    typingTimer.current = setTimeout(() => { typingTimer.current = null }, 3_000)
  }

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: false, horizontalRule: false }),
      ChatMarkdown,
      Placeholder.configure({ placeholder: thread ? `Message ${channel}` : `Message /${channel}` }),
    ],
    editorProps: {
      attributes: {
        class: "chat-composer flex-1 min-w-0 max-h-40 overflow-y-auto thin-scrollbar text-sm leading-relaxed outline-none",
      },
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault()
          send()
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor }) => {
      // detect a trailing "@token" in the current line for the mention dropdown
      const text = editor.state.doc.textBetween(0, editor.state.selection.from, "\n", "\n")
      const m = text.match(/@(\w*)$/)
      setMentionQuery(m ? m[1].toLowerCase() : null)
      fireTyping()
    },
  })

  const mentionMatches = mentionQuery !== null
    ? members.filter((f) => f.name.toLowerCase().includes(mentionQuery)).slice(0, 5)
    : []

  const send = () => {
    if (!editor || (editor.isEmpty && pendingFiles.length === 0)) return
    const markdown = editor.isEmpty ? "" : decodeChatEntities(editor.getMarkdown() || "").trim()
    onSend?.(markdown, pendingFiles.length > 0 ? pendingFiles : undefined)
    editor.commands.clearContent()
    setPendingFiles([])
    setMentionQuery(null)
  }

  const pickMention = (name: string) => {
    if (!editor) return
    // replace the trailing "@token" with "@Name "
    const { from } = editor.state.selection
    const text = editor.state.doc.textBetween(0, from, "\n", "\n")
    const tokenLen = (text.match(/@\w*$/)?.[0].length) ?? 0
    editor.chain().focus().deleteRange({ from: from - tokenLen, to: from }).insertContent(`@${name} `).run()
    setMentionQuery(null)
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
    <div className="relative px-2 pb-2 pt-0">
      {/* @mention autocomplete — floats above the input */}
      {mentionMatches.length > 0 && (
        <div className="absolute bottom-full left-2 right-2 mb-1 overflow-hidden rounded-lg border border-border bg-popover shadow-[var(--e2)]">
          <div className="border-b border-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Members</div>
          {mentionMatches.map((f) => (
            <button key={f.id} onClick={() => pickMention(f.name)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent">
              <Avatar label={f.avatar} size={24} presence={f.status} />
              <span className="text-sm font-medium">{f.name}</span>
            </button>
          ))}
        </div>
      )}

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
              <div key={i} className="group relative flex items-center gap-2 rounded border border-border bg-background px-3 py-1.5 text-xs">
                {isImage ? <ImageIcon className="size-3.5 text-muted-foreground" /> : <FileIcon className="size-3.5 text-muted-foreground" />}
                <span className="max-w-[120px] truncate text-foreground">{file.name}</span>
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

      <div className={`flex min-h-14 items-center gap-2 bg-muted px-4 py-2 shadow-[var(--e1)] ring-1 ring-border/40 ${replyingTo || pendingFiles.length > 0 ? "rounded-b-xl" : "rounded-xl"}`}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,audio/*,.pdf,.txt,.zip"
          onChange={handleFileSelect}
          className="hidden"
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<button className="shrink-0 text-muted-foreground hover:text-foreground aria-expanded:text-foreground" aria-label="Add" />}
          >
            <PlusCircle className="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-44">
            <DropdownMenuItem onClick={() => fileInputRef.current?.click()}><Upload className="size-4" /> Upload a File</DropdownMenuItem>
            {!thread && <DropdownMenuItem onClick={onCreateThread}><MessagesSquare className="size-4" /> Create Thread</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
        <EditorContent editor={editor} className="min-w-0 flex-1" />
        <EmojiPickerPopover side="top" align="end" onPick={(e) => editor?.chain().focus().insertContent(e).run()}>
          <button className="shrink-0 text-muted-foreground hover:text-foreground aria-expanded:text-foreground" aria-label="Emoji picker">
            <Smile className="size-5" />
          </button>
        </EmojiPickerPopover>
      </div>
    </div>
  )
}
