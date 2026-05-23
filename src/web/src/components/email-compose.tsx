"use client";

import { useState, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import Image from "@tiptap/extension-image";
import { EmailToolbar } from "@/components/email-toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { EmailAttachment } from "@alook/shared";
import { toast } from "sonner";
import { Send, X, Loader2, Paperclip, File as FileIcon } from "lucide-react";

interface EmailComposeProps {
  fromAddress: string;
  onSend: (to: string, subject: string, htmlBody: string, attachments: EmailAttachment[], threading?: { inReplyTo?: string; references?: string }) => Promise<boolean>;
  onDiscard: () => void;
  initialTo?: string;
  initialSubject?: string;
  initialBody?: string;
  initialAttachments?: EmailAttachment[];
  inReplyTo?: string;
  references?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function EmailCompose({
  fromAddress,
  onSend,
  onDiscard,
  initialTo = "",
  initialSubject = "",
  initialBody = "",
  initialAttachments = [],
  inReplyTo,
  references,
}: EmailComposeProps) {
  const [to, setTo] = useState(initialTo);
  const [subject, setSubject] = useState(initialSubject);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<EmailAttachment[]>(initialAttachments);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    immediatelyRender: false,
    content: initialBody || undefined,
    extensions: [
      StarterKit.configure({
        link: false,
        underline: false,
      }),
      Placeholder.configure({ placeholder: "Write your email..." }),
      Underline,
      Link.configure({
        autolink: true,
        openOnClick: false,
        linkOnPaste: true,
      }),
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
      TextStyle,
      Color,
      Image.configure({
        inline: true,
        allowBase64: true,
      }),
    ],
    editorProps: {
      attributes: {
        class: "text-sm max-w-none focus:outline-none min-h-50 px-4 py-3",
      },
    },
  });

  const handleSend = async () => {
    if (!to.trim() || !subject.trim() || !editor) return;
    setSending(true);
    try {
      const html = editor.getHTML();
      const threading = inReplyTo || references ? { inReplyTo, references } : undefined;
      const ok = await onSend(to.trim(), subject.trim(), html, attachments, threading);
      if (ok) {
        setTo("");
        setSubject("");
        setAttachments([]);
        editor.commands.clearContent();
      }
    } finally {
      setSending(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    try {
      const { uploadEmailAttachment } = await import("@/lib/api");
      for (const file of Array.from(files)) {
        if (file.size > 10 * 1024 * 1024) {
          toast.error(`${file.name} exceeds 10 MB limit`);
          continue;
        }
        const workspaceId = new URLSearchParams(window.location.search).get("workspace_id") ?? "";
        const meta = await uploadEmailAttachment(file, workspaceId);
        setAttachments((prev) => [...prev, meta]);
      }
    } catch {
      toast.error("Failed to upload attachment");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeAttachment = (key: string) => {
    setAttachments((prev) => prev.filter((a) => a.key !== key));
  };

  return (
    <div className="flex flex-col h-full w-full min-w-0">
      <div className="flex items-center justify-between border-b border-border/40 px-4 py-2">
        <h3 className="text-sm font-heading font-medium tracking-tight">New Email</h3>
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

      <div className="border-b border-border/30 px-4 py-2.5 space-y-1 min-w-0">
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-muted-foreground w-16 shrink-0">From</span>
          <span className="text-muted-foreground truncate min-w-0">{fromAddress}</span>
        </div>
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-muted-foreground w-16 shrink-0">To</span>
          <div className="flex-1 min-w-0 -ml-1.5 rounded-md bg-muted/40">
            <Input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com"
              className="h-7 text-sm border-0 bg-transparent px-1.5 shadow-none focus-visible:ring-0 placeholder:text-muted-foreground/50"
              disabled={sending}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-muted-foreground w-16 shrink-0">Subject</span>
          <div className="flex-1 min-w-0 -ml-1.5 rounded-md bg-muted/40">
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Email subject"
              className="h-7 text-sm border-0 bg-transparent px-1.5 shadow-none focus-visible:ring-0 placeholder:text-muted-foreground/50"
              disabled={sending}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center border-b border-border/30">
        <EmailToolbar editor={editor} />
        <div className="flex items-center gap-1 px-2 border-l border-border/30">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={uploading}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => fileInputRef.current?.click()}
                  className="text-muted-foreground/70"
                />
              }
            >
              {uploading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Paperclip className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipContent>Attach file</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 py-2 border-b border-border/30">
          {attachments.map((att) => (
            <div
              key={att.key}
              className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs"
            >
              <FileIcon className="size-3 text-muted-foreground shrink-0" />
              <span className="truncate max-w-37.5">{att.filename}</span>
              <span className="text-muted-foreground shrink-0">{formatFileSize(att.size)}</span>
              <button
                type="button"
                onClick={() => removeAttachment(att.key)}
                className="text-muted-foreground hover:text-foreground ml-0.5 cursor-pointer"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto thin-scrollbar">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
