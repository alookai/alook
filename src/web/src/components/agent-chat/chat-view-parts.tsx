"use client";

import React from "react";
import { FileText } from "lucide-react";
import type { Artifact } from "@alook/shared";
import { useAgentContext } from "@/contexts/agent-context";
import { AgentPreviewCard } from "@/components/agent-preview-card";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { SystemCard } from "@/components/agent-chat/message-list";
import { formatSize } from "@/components/agent-chat/artifact-sheet";

function MentionHighlight(
  props: Record<string, unknown> & { children?: React.ReactNode },
) {
  const { children, ...rest } = props;
  const { agents } = useAgentContext();
  const agentId = (rest["data-agent-id"] ?? rest.dataAgentId) as
    | string
    | undefined;
  let agent = agentId ? agents.find((a) => a.id === agentId) : undefined;
  if (!agent && typeof children === "string") {
    const nameToMatch = children.startsWith("@") ? children.slice(1) : children;
    agent = agents.find(
      (a) => a.name.toLowerCase() === nameToMatch.toLowerCase(),
    );
  }
  if (agent) {
    return (
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={300}
          nativeButton={false}
          render={<span className="mention-highlight cursor-pointer" />}
        >
          {children}
        </PopoverTrigger>
        <PopoverContent side="top" className="w-fit max-w-80">
          <AgentPreviewCard agent={agent} />
        </PopoverContent>
      </Popover>
    );
  }
  return <span className="mention-highlight">{children}</span>;
}

export const MENTION_COMPONENTS: Record<
  string,
  React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>
> = {
  mention: MentionHighlight,
  p: ({
    children,
    node,
    ...rest
  }: Record<string, unknown> & { children?: React.ReactNode }) => {
    void node;
    return (
      <div data-md-p="" {...rest}>
        {children}
      </div>
    );
  },
};

export function NapSeparator({ agentName }: { agentName: string }) {
  return (
    <div className="flex items-center gap-3 py-4 select-none" aria-hidden>
      <div className="flex-1 border-t border-border/40" />
      <span className="text-xs text-muted-foreground/60 whitespace-nowrap">
        {agentName} took a nap 💤
      </span>
      <div className="flex-1 border-t border-border/40" />
    </div>
  );
}

// Agent-side artifact (file) card — same shared SystemCard shell + card
// language as the event cards (locked prototype: icon chip / FILE / filename /
// size). The version badge rides along as the title's trailing element.
export function ArtifactCard({
  artifact,
  version,
  hasDuplicates,
  onClick,
}: {
  artifact: Artifact;
  version: number;
  hasDuplicates: boolean;
  onClick: (a: Artifact) => void;
}) {
  return (
    <SystemCard
      icon={FileText}
      label="FILE"
      title={artifact.filename}
      preview={formatSize(artifact.size)}
      trailing={
        hasDuplicates ? (
          <span className="shrink-0 text-xs text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 font-normal">
            v{version}
          </span>
        ) : undefined
      }
      onClick={() => onClick(artifact)}
    />
  );
}
