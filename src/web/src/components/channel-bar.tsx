"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { useChannel } from "@/contexts/channel-context";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function ChannelBar() {
  const {
    channels,
    activeChannel,
    loading,
    setActiveChannel,
    createChannel,
    renameChannel,
    deleteChannel,
  } = useChannel();

  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="h-8 flex items-center gap-1.5 px-2 mb-1 shrink-0">
        <div className="h-5 w-14 rounded-md bg-muted animate-pulse" />
        <div className="h-5 w-12 rounded-md bg-muted animate-pulse" />
        <div className="h-5 w-16 rounded-md bg-muted animate-pulse" />
      </div>
    );
  }

  return (
    <div className="h-8 flex items-center gap-1.5 px-2 mb-1 overflow-x-auto thin-scrollbar shrink-0">
      {channels.map((ch) =>
        renamingId === ch.id ? (
          <RenameInput
            key={ch.id}
            currentName={ch.name}
            onSave={async (name) => {
              try {
                await renameChannel(ch.id, name);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed to rename");
              }
              setRenamingId(null);
            }}
            onCancel={() => setRenamingId(null)}
          />
        ) : (
          <ChannelPill
            key={ch.id}
            id={ch.id}
            name={ch.name}
            active={ch.name === activeChannel}
            deleting={deletingId === ch.id}
            onSelect={() => setActiveChannel(ch.name)}
            onRename={() => setRenamingId(ch.id)}
            onDeleteRequest={() => setDeletingId(ch.id)}
            onDeleteCancel={() => setDeletingId(null)}
            onDeleteConfirm={async () => {
              try {
                await deleteChannel(ch.id);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed to delete");
              }
              setDeletingId(null);
            }}
          />
        )
      )}

      {creating ? (
        <CreateInput
          onSave={async (name) => {
            try {
              await createChannel(name);
              setActiveChannel(name);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Failed to create");
            }
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                onClick={() => setCreating(true)}
                className="h-5 w-5 rounded-md border border-dashed border-muted-foreground/30 text-muted-foreground hover:border-foreground/50 hover:text-foreground hover:bg-accent transition-colors duration-200 inline-flex items-center justify-center cursor-pointer shrink-0"
              />
            }
          >
            <Plus className="size-3" />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Add New Chatting Channel
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function ChannelPill({
  name,
  active,
  deleting,
  onSelect,
  onRename,
  onDeleteRequest,
  onDeleteCancel,
  onDeleteConfirm,
}: {
  id: string;
  name: string;
  active: boolean;
  deleting: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDeleteRequest: () => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: () => void;
}) {
  const isDefault = name === "default";

  const pillClasses = cn(
    "h-5 px-1.5 rounded-md text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer select-none transition-colors duration-200 shrink-0",
    "active:translate-y-px focus-visible:ring-2 focus-visible:ring-ring/50 outline-none",
    active
      ? "bg-secondary text-foreground shadow-sm ring-1 ring-foreground/5"
      : "text-muted-foreground hover:text-foreground hover:bg-accent"
  );

  if (isDefault) {
    return (
      <button onClick={onSelect} className={pillClasses}>
        #{name}
      </button>
    );
  }

  return (
    <Tooltip>
      <Popover open={deleting} onOpenChange={(open) => { if (!open) onDeleteCancel(); }}>
        <ContextMenu>
          <TooltipTrigger
            render={
              <ContextMenuTrigger className="inline-flex" />
            }
          >
            <PopoverTrigger
              render={
                <button onClick={onSelect} className={pillClasses} />
              }
            >
              #{name}
            </PopoverTrigger>
          </TooltipTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={onRename}>
              <Pencil className="size-3.5 mr-2" />
              Rename
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={onDeleteRequest}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="size-3.5 mr-2" />
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <PopoverContent className="w-auto p-3" align="start">
          <p className="text-sm mb-3">
            Delete &ldquo;{name}&rdquo;? Its conversations will be removed.
          </p>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={onDeleteCancel}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={onDeleteConfirm}>
              Delete
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <TooltipContent side="bottom">Right-click for options</TooltipContent>
    </Tooltip>
  );
}

function CreateInput({
  onSave,
  onCancel,
}: {
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const savedRef = useRef(false);
  const [value, setValue] = useState("");

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed) {
      savedRef.current = true;
      onSave(trimmed);
    } else {
      onCancel();
    }
  }, [value, onSave, onCancel]);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") handleSubmit();
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => { if (!savedRef.current) onCancel(); }}
      placeholder="name..."
      className="h-5 w-24 px-1.5 rounded-md text-[11px] bg-transparent border border-input focus:border-ring focus:ring-2 focus:ring-ring/50 placeholder:text-muted-foreground/50 outline-none shrink-0"
    />
  );
}

function RenameInput({
  currentName,
  onSave,
  onCancel,
}: {
  currentName: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const savedRef = useRef(false);
  const readyRef = useRef(false);
  const [value, setValue] = useState(currentName);

  useEffect(() => {
    // Delay focus so the ContextMenu finishes its close transition first
    const id = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
      readyRef.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== currentName) {
      savedRef.current = true;
      onSave(trimmed);
    } else {
      onCancel();
    }
  }, [value, currentName, onSave, onCancel]);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") handleSubmit();
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => { if (readyRef.current && !savedRef.current) onCancel(); }}
      className="h-5 w-24 px-1.5 rounded-md text-[11px] bg-transparent border border-input focus:border-ring focus:ring-2 focus:ring-ring/50 outline-none shrink-0"
    />
  );
}

