"use client";

import { useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, X, Loader2 } from "lucide-react";

interface EmailComposeProps {
  fromAddress: string;
  onSend: (to: string, subject: string, htmlBody: string) => Promise<boolean>;
  onDiscard: () => void;
}

export function EmailCompose({ fromAddress, onSend, onDiscard }: EmailComposeProps) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [sending, setSending] = useState(false);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "Write your email..." }),
    ],
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none focus:outline-none min-h-[200px] px-4 py-3",
      },
    },
  });

  const handleSend = async () => {
    if (!to.trim() || !subject.trim() || !editor) return;
    setSending(true);
    try {
      const html = editor.getHTML();
      const ok = await onSend(to.trim(), subject.trim(), html);
      if (ok) {
        setTo("");
        setSubject("");
        editor.commands.clearContent();
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-border/40 px-4 py-2">
        <h3 className="text-sm font-medium">New Email</h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground h-7 px-2"
            onClick={onDiscard}
            disabled={sending}
          >
            <X className="size-3 mr-1" />
            Discard
          </Button>
          <Button
            size="sm"
            className="text-xs h-7 px-3"
            onClick={handleSend}
            disabled={sending || !to.trim() || !subject.trim()}
          >
            {sending ? (
              <Loader2 className="size-3 mr-1 animate-spin" />
            ) : (
              <Send className="size-3 mr-1" />
            )}
            Send
          </Button>
        </div>
      </div>

      <div className="border-b border-border/30 px-4 py-2 space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground w-14 shrink-0">From:</span>
          <span className="text-foreground/70">{fromAddress}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground w-14 shrink-0">To:</span>
          <Input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="recipient@example.com"
            className="h-7 text-sm border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            disabled={sending}
          />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground w-14 shrink-0">Subject:</span>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Email subject"
            className="h-7 text-sm border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            disabled={sending}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
