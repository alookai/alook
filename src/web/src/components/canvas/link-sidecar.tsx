"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Agent, AgentLink } from "@alook/shared";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "@/components/ui/markdown-editor";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Trash2 } from "lucide-react";
import { AvatarRenderer, parseAvatarUrl } from "@/components/avatar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

const DEBOUNCE_MS = 500;

interface LinkSidecarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  link: AgentLink | null;
  agents: Agent[];
  onSave: (id: string, instruction: string) => void;
  onDelete: (id: string) => void;
}

export function LinkSidecar({
  open,
  onOpenChange,
  link,
  agents,
  onSave,
  onDelete,
}: LinkSidecarProps) {
  const [instruction, setInstruction] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const instructionRef = useRef(instruction);
  useEffect(() => {
    instructionRef.current = instruction;
  }, [instruction]);
  const savedInstructionRef = useRef("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const linkRef = useRef(link);
  useEffect(() => {
    linkRef.current = link;
  }, [link]);

  const sourceAgent = agents.find((a) => a.id === link?.source_agent_id);
  const targetAgent = agents.find((a) => a.id === link?.target_agent_id);

  useEffect(() => {
    if (link) {
      setInstruction(link.instruction);
      savedInstructionRef.current = link.instruction;
    }
  }, [link]);

  const flushSave = useCallback(() => {
    const current = instructionRef.current;
    const l = linkRef.current;
    if (!l || current === savedInstructionRef.current) return;
    savedInstructionRef.current = current;
    onSave(l.id, current);
  }, [onSave]);

  const scheduleSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(flushSave, DEBOUNCE_MS);
  }, [flushSave]);

  const handleChange = useCallback(
    (next: string) => {
      setInstruction(next);
      scheduleSave();
    },
    [scheduleSave],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      flushSave();
    };
  }, [flushSave]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        flushSave();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, flushSave],
  );

  const handleDeleteConfirm = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (link) onDelete(link.id);
    setConfirmOpen(false);
  }, [link, onDelete]);

  const renderAvatar = (agent: Agent | undefined) => {
    if (!agent) return null;
    const avatarConfig = parseAvatarUrl(agent.avatar_url);
    if (avatarConfig) {
      return <AvatarRenderer config={avatarConfig} size={32} className="shrink-0 rounded-xl" />;
    }
    return (
      <div className="flex items-center justify-center size-8 rounded-xl bg-secondary text-secondary-foreground text-xs font-medium shrink-0">
        {agent.name.charAt(0).toUpperCase()}
      </div>
    );
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border data-[side=right]:sm:max-w-md"
      >
        <SheetTitle className="sr-only">
          Edit relationship between {sourceAgent?.name} and {targetAgent?.name}
        </SheetTitle>

        <SheetHeader className="border-b px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex items-center">
                {renderAvatar(sourceAgent)}
                <div className="-ml-2 ring-2 ring-background rounded-xl">
                  {renderAvatar(targetAgent)}
                </div>
              </div>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => setConfirmOpen(true)}
                  />
                }
              >
                <Trash2 className="size-4" />
              </TooltipTrigger>
              <TooltipContent>Remove connection</TooltipContent>
            </Tooltip>
          </div>
          <p className="text-sm font-medium">
            {sourceAgent?.name ?? "Agent"} and {targetAgent?.name ?? "Agent"}
          </p>
          <p className="text-xs font-medium text-muted-foreground tracking-wide mb-2">
            use @ to mention agent
          </p>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto thin-scrollbar px-5 py-4">
          <MarkdownEditor
            variant="seamless"
            contentType="markdown"
            placeholder="Describe how these agents should collaborate. This instruction is shared with both agents when they receive tasks."
            value={instruction}
            onChange={handleChange}
            minHeight="12rem"
            agents={agents}
          />
        </div>
      </SheetContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Remove connection"
        description={`This will remove the connection between "${sourceAgent?.name ?? "Agent"}" and "${targetAgent?.name ?? "Agent"}".`}
        onConfirm={handleDeleteConfirm}
      />
    </Sheet>
  );
}
