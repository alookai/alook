"use client"

import { useState } from "react"
import { PlusCircle, Smile, Upload, MessagesSquare, X } from "lucide-react"
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
// opens an attach/thread menu (Discord parity — Upload a File / Create Thread only).
export function Composer({ channel, thread, members, onSend, onUploadFile, onCreateThread, replyingTo, onCancelReply }: {
  channel: string
  thread?: boolean
  members: Friend[]
  onSend?: (markdown: string) => void
  onUploadFile?: () => void
  onCreateThread?: () => void
  // when set, shows a "Replying to X" bar above the input
  replyingTo?: string
  onCancelReply?: () => void
}) {
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: false, horizontalRule: false }),
      ChatMarkdown,
      Placeholder.configure({ placeholder: thread ? `Message ${channel}` : `Message #${channel}` }),
    ],
    editorProps: {
      attributes: {
        class: "chat-composer flex-1 min-w-0 max-h-40 overflow-y-auto thin-scrollbar text-[15px] leading-[1.4] outline-none",
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
    },
  })

  const mentionMatches = mentionQuery !== null
    ? members.filter((f) => f.name.toLowerCase().includes(mentionQuery)).slice(0, 5)
    : []

  const send = () => {
    if (!editor || editor.isEmpty) return
    onSend?.(decodeChatEntities(editor.getMarkdown() || "").trim())
    editor.commands.clearContent()
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

  return (
    <div className="relative px-2 pb-2 pt-0">
      {/* @mention autocomplete — floats above the input */}
      {mentionMatches.length > 0 && (
        <div className="absolute bottom-full left-2 right-2 mb-1 overflow-hidden rounded-lg border border-border bg-popover shadow-(--e2)">
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
        <div className="flex items-center gap-2 rounded-t-lg border-b border-border bg-secondary/60 px-4 py-1.5 text-xs text-muted-foreground">
          <span>Replying to <span className="font-medium text-foreground">{replyingTo}</span></span>
          <button onClick={onCancelReply} className="ml-auto grid size-4 place-items-center rounded-full hover:bg-foreground/10 hover:text-foreground" aria-label="Cancel reply">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div className={`flex min-h-14 items-center gap-3 bg-secondary px-4 py-3 ${replyingTo ? "rounded-b-lg" : "rounded-lg"}`}>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<button className="shrink-0 text-muted-foreground hover:text-foreground aria-expanded:text-foreground" aria-label="Add" />}
          >
            <PlusCircle className="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-44">
            <DropdownMenuItem onClick={onUploadFile}><Upload className="size-4" /> Upload a File</DropdownMenuItem>
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
