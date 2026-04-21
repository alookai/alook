"use client";

import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { cn } from "@/lib/utils";
import { isEmptyHtml } from "@alook/shared";

export { isEmptyHtml };

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  minHeight?: number | string;
  autoFocus?: boolean;
  /** `default` is framed (border + focus ring); `seamless` blends with the parent. */
  variant?: "default" | "seamless";
  /** `html` (default) — value/onChange use HTML. `markdown` — value/onChange use Markdown text. */
  contentType?: "html" | "markdown";
}

function normalize(html: string | null | undefined): string {
  if (!html) return "";
  return isEmptyHtml(html) ? "" : html.trim();
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  className,
  minHeight = "9rem",
  autoFocus,
  variant = "default",
  contentType = "html",
}: MarkdownEditorProps) {
  const isMd = contentType === "markdown";

  const minHeightStyle =
    typeof minHeight === "number" ? `${minHeight}px` : minHeight;

  const innerClass =
    variant === "seamless"
      ? "markdown text-sm max-w-none focus:outline-none px-0 py-1"
      : "markdown text-sm max-w-none focus:outline-none px-3 py-2";

  const editor = useEditor({
    immediatelyRender: false,
    content: value || undefined,
    ...(isMd ? { contentType: "markdown" } : {}),
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      ...(isMd ? [Markdown] : []),
    ],
    editorProps: {
      attributes: {
        class: innerClass,
        style: `min-height: ${minHeightStyle}`,
      },
    },
    autofocus: autoFocus ? "end" : false,
    onUpdate: ({ editor }) => {
      onChange(isMd ? editor.getMarkdown() : editor.getHTML());
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (isMd) {
      const incoming = (value || "").trim();
      const current = (editor.getMarkdown() || "").trim();
      if (incoming === current) return;
      editor.commands.setContent(value || "", { emitUpdate: false, contentType: "markdown" });
    } else {
      const incoming = normalize(value);
      const current = normalize(editor.getHTML());
      if (incoming === current) return;
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  const containerClass =
    variant === "seamless"
      ? "w-full bg-transparent text-sm"
      : "w-full rounded-md border border-input bg-transparent text-sm transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50";

  return (
    <div className={cn(containerClass, className)}>
      <EditorContent editor={editor} />
    </div>
  );
}
