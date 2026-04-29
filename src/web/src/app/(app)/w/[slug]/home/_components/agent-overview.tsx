"use client";

import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardAction, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useWorkspace } from "@/contexts/workspace-context";
import { MessageSquare, Mail, Plus } from "lucide-react";
import type { Agent, AgentRuntime } from "@alook/shared";
import type { WorkspaceOverview } from "@/lib/api";

interface AgentOverviewProps {
  agents: Agent[];
  runtimes: AgentRuntime[];
  activeTaskCounts: Record<string, number>;
  overview: WorkspaceOverview;
}

export function AgentOverview({ agents, runtimes, activeTaskCounts, overview }: AgentOverviewProps) {
  const router = useRouter();
  const { slug } = useWorkspace();

  if (agents.length === 0) return null;

  return (
    <Card className="flex flex-col lg:max-h-[33%]">
      <CardHeader>
        <CardTitle>Agents</CardTitle>
        <CardAction>
          <button
            type="button"
            onClick={() => router.push(`/w/${slug}/agents/new`)}
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <Plus className="size-4" />
          </button>
        </CardAction>
      </CardHeader>
      <CardContent className="p-0 flex-1 min-h-0 overflow-y-auto thin-scrollbar">
        <div className="divide-y divide-border/50">
          {agents.map((agent) => {
            const rt = runtimes.find((r) => r.id === agent.runtime_id);
            const isOnline = rt?.status === "online";
            const tasks = activeTaskCounts[agent.id] ?? 0;
            const convos = overview.conversation_counts[agent.id] ?? 0;

            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => router.push(`/w/${slug}/agents/${agent.id}`)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/50 transition-colors cursor-pointer"
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground text-sm font-medium">
                  {agent.name.charAt(0).toUpperCase()}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{agent.name}</span>
                    <Tooltip>
                      <TooltipTrigger render={
                        <span
                          className={`size-2 rounded-full shrink-0 ${isOnline ? "bg-emerald-500" : "bg-muted-foreground/30"}`}
                        />
                      } />
                      <TooltipContent side="top">{isOnline ? "Online" : "Offline"}</TooltipContent>
                    </Tooltip>
                    {agent.visibility === "public" && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        public
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                  {tasks > 0 && (
                    <Tooltip>
                      <TooltipTrigger render={
                        <span className="flex items-center gap-1 text-primary font-medium">
                          <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                          {tasks} active
                        </span>
                      } />
                      <TooltipContent side="top">{tasks} active task{tasks > 1 ? "s" : ""}</TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger render={
                      <span className="flex items-center gap-1">
                        <MessageSquare className="size-3" />
                        {convos}
                      </span>
                    } />
                    <TooltipContent side="top">{convos} conversation{convos !== 1 ? "s" : ""}</TooltipContent>
                  </Tooltip>
                  {agent.email_handle && (
                    <Tooltip>
                      <TooltipTrigger render={
                        <span className="flex items-center">
                          <Mail className="size-3" />
                        </span>
                      } />
                      <TooltipContent side="top">{agent.email_handle}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
