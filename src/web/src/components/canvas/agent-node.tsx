"use client";

import { memo, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Agent, AgentRuntime } from "@alook/shared";
import { AgentPreviewCard } from "@/components/agent-preview-card";
import { cn } from "@/lib/utils";

export interface AgentNodeData {
  agent: Agent;
  runtimes: AgentRuntime[];
  activeTaskCount: number;
  slug: string;
  index: number;
  [key: string]: unknown;
}

const handleClass =
  "!opacity-0 !size-3 !bg-muted-foreground/40 !rounded-full group-hover:!opacity-100 hover:!bg-primary hover:!scale-125 !transition-all !border-none";

function AgentNodeInner({ data, selected, dragging }: NodeProps) {
  const { agent, runtimes, activeTaskCount, index } = data as unknown as AgentNodeData;

  const rt = runtimes.find((r: AgentRuntime) => r.id === agent.runtime_id);
  const isOnline = rt?.status === "online";
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      data-agent-node-id={agent.id}
      data-agent-working={activeTaskCount > 0 ? "true" : "false"}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        "bg-background rounded-xl ring-1 ring-foreground/8 shadow-sm transition-[box-shadow,ring-color,opacity,transform] duration-200 py-3 px-4 group",
        selected && "ring-2 ring-primary/20 shadow-md",
        !selected && "hover:ring-foreground/15 hover:shadow-md",
        dragging && "shadow-lg scale-[1.02] cursor-grabbing",
      )}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <Handle type="source" id="right" position={Position.Right} className={handleClass} />
      <Handle type="source" id="left" position={Position.Left} className={handleClass} />
      <Handle type="source" id="top" position={Position.Top} className={handleClass} />
      <Handle type="source" id="bottom" position={Position.Bottom} className={handleClass} />

      <Handle type="target" id="target-right" position={Position.Right} className={handleClass} />
      <Handle type="target" id="target-left" position={Position.Left} className={handleClass} />
      <Handle type="target" id="target-top" position={Position.Top} className={handleClass} />
      <Handle type="target" id="target-bottom" position={Position.Bottom} className={handleClass} />

      <AgentPreviewCard
        agent={agent}
        isOnline={isOnline}
        activeTaskCount={activeTaskCount}
        variant="compact"
        isHovered={isHovered}
      />
    </div>
  );
}

export const AgentNode = memo(AgentNodeInner);
