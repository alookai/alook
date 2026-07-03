"use client";

import { useState, useRef, useEffect, useReducer } from "react";
import type { Editor } from "@tiptap/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Link,
  Unlink,
  ImageIcon,
  Heading1,
  Heading2,
  Minus,
} from "lucide-react";

interface EmailToolbarProps {
  editor: Editor | null;
}

function ToolbarButton({
  active,
  disabled,
  onAction,
  title,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onAction: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onAction}
            className={cn(
              "text-muted-foreground/70",
              active && "bg-accent text-foreground"
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-4 bg-border/60 mx-1 shrink-0" />;
}

export function EmailToolbar({ editor }: EmailToolbarProps) {
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"link" | "image">("link");
  const [urlValue, setUrlValue] = useState("");
  const [urlError, setUrlError] = useState("");
  const [displayText, setDisplayText] = useState("");
  const [selectionEmpty, setSelectionEmpty] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const linkActiveOnMouseDown = useRef(false);

  useEffect(() => {
    if (!editor) return;
    const handler = () => forceUpdate();
    editor.on("transaction", handler);
    return () => { editor.off("transaction", handler); };
  }, [editor]);

  useEffect(() => {
    if (dialogOpen) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [dialogOpen]);

  if (!editor) return null;

  const iconSize = "size-3.5";


  const handleImage = () => {
    setDialogMode("image");
    setUrlValue("");
    setUrlError("");
    setDialogOpen(true);
  };

  const handleDialogSubmit = () => {
    const trimmed = urlValue.trim();
    if (!trimmed) return;
    try {
      new URL(trimmed);
    } catch {
      setUrlError("Please enter a valid URL");
      return;
    }
    setUrlError("");
    if (dialogMode === "link") {
      if (selectionEmpty) {
        const text = displayText.trim() || trimmed;
        editor.chain().focus().insertContent({
          type: "text",
          text,
          marks: [{ type: "link", attrs: { href: trimmed } }],
        }).run();
      } else {
        editor.chain().focus().extendMarkRange("link").setLink({ href: trimmed }).run();
      }
    } else {
      editor.chain().focus().setImage({ src: trimmed }).run();
    }
    setDialogOpen(false);
  };

  return (
    <div className="flex items-center gap-1 px-3 py-1 overflow-x-auto">
      {/* Inline formatting */}
      <ToolbarButton
        title="Bold"
        active={editor.isActive("bold")}
        onAction={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        title="Italic"
        active={editor.isActive("italic")}
        onAction={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        title="Underline"
        active={editor.isActive("underline")}
        onAction={() => editor.chain().focus().toggleUnderline().run()}
      >
        <Underline className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        title="Strikethrough"
        active={editor.isActive("strike")}
        onAction={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough className={iconSize} />
      </ToolbarButton>

      <ToolbarDivider />

      {/* Headings */}
      <ToolbarButton
        title="Heading 1"
        active={editor.isActive("heading", { level: 1 })}
        onAction={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        title="Heading 2"
        active={editor.isActive("heading", { level: 2 })}
        onAction={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 className={iconSize} />
      </ToolbarButton>

      <ToolbarDivider />

      {/* Lists */}
      <ToolbarButton
        title="Bullet List"
        active={editor.isActive("bulletList")}
        onAction={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        title="Ordered List"
        active={editor.isActive("orderedList")}
        onAction={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className={iconSize} />
      </ToolbarButton>

      <ToolbarDivider />

      {/* Alignment */}
      <ToolbarButton
        title="Align Left"
        active={editor.isActive({ textAlign: "left" })}
        onAction={() => editor.chain().focus().setTextAlign("left").run()}
      >
        <AlignLeft className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        title="Align Center"
        active={editor.isActive({ textAlign: "center" })}
        onAction={() => editor.chain().focus().setTextAlign("center").run()}
      >
        <AlignCenter className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        title="Align Right"
        active={editor.isActive({ textAlign: "right" })}
        onAction={() => editor.chain().focus().setTextAlign("right").run()}
      >
        <AlignRight className={iconSize} />
      </ToolbarButton>

      <ToolbarDivider />

      {/* Link & Image — custom handler to capture isActive before click */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              onMouseDown={(e) => {
                e.preventDefault();
                linkActiveOnMouseDown.current = editor.isActive("link");
              }}
              onClick={() => {
                if (linkActiveOnMouseDown.current) {
                  editor.chain().focus().unsetLink().run();
                } else {
                  setDialogMode("link");
                  setUrlValue("");
                  setUrlError("");
                  setDisplayText("");
                  setSelectionEmpty(editor.state.selection.empty);
                  setDialogOpen(true);
                }
              }}
              className={cn(
                "text-muted-foreground/70",
                editor.isActive("link") && "bg-accent text-foreground"
              )}
            />
          }
        >
          {editor.isActive("link") ? (
            <Unlink className={iconSize} />
          ) : (
            <Link className={iconSize} />
          )}
        </TooltipTrigger>
        <TooltipContent>{editor.isActive("link") ? "Remove Link" : "Insert Link"}</TooltipContent>
      </Tooltip>
      <ToolbarButton title="Insert Image" onAction={handleImage}>
        <ImageIcon className={iconSize} />
      </ToolbarButton>

      <ToolbarDivider />

      {/* Horizontal Rule */}
      <ToolbarButton
        title="Horizontal Rule"
        onAction={() => editor.chain().focus().setHorizontalRule().run()}
      >
        <Minus className={iconSize} />
      </ToolbarButton>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialogMode === "link" ? "Insert Link" : "Insert Image"}
            </DialogTitle>
          </DialogHeader>
          {dialogMode === "link" && selectionEmpty && (
            <Input
              ref={inputRef}
              value={displayText}
              onChange={(e) => setDisplayText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleDialogSubmit();
              }}
              placeholder="Display text"
            />
          )}
          <div className="space-y-1">
            <Input
              ref={dialogMode === "image" || !selectionEmpty ? inputRef : undefined}
              value={urlValue}
              onChange={(e) => { setUrlValue(e.target.value); setUrlError(""); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleDialogSubmit();
              }}
              placeholder={dialogMode === "link" ? "https://example.com" : "https://example.com/image.png"}
              type="url"
              aria-invalid={Boolean(urlError)}
            />
            {urlError && <p className="text-xs text-destructive">{urlError}</p>}
          </div>
          <DialogFooter>
            <Button onClick={handleDialogSubmit} disabled={!urlValue.trim()}>
              Insert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
