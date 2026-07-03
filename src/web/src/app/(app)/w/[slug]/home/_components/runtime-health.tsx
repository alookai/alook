"use client";

import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardAction, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useWorkspace } from "@/contexts/workspace-context";
import { ArrowUpRight } from "lucide-react";
import type { Agent, AgentRuntime } from "@alook/shared";

interface RuntimeHealthProps {
  runtimes: AgentRuntime[];
  agents: Agent[];
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function RuntimeHealth({ runtimes, agents }: RuntimeHealthProps) {
  const router = useRouter();
  const { slug } = useWorkspace();
  const machineMap = new Map<string, { runtimes: AgentRuntime[]; deviceInfo: string }>();
  for (const rt of runtimes) {
    const key = rt.daemon_id ?? rt.id;
    if (!machineMap.has(key)) {
      machineMap.set(key, { runtimes: [], deviceInfo: rt.device_info ?? "" });
    }
    machineMap.get(key)!.runtimes.push(rt);
  }

  const machines = [...machineMap.entries()];

  if (machines.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Machines</CardTitle>
          <CardAction>
            <button
              type="button"
              onClick={() => router.push(`/w/${slug}/runtimes`)}
              className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <ArrowUpRight className="size-4" />
            </button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No machines connected.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Machines</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {machines.map(([daemonId, machine]) => {
          const isOnline = machine.runtimes.some((r) => r.status === "online");
          const lastSeen = machine.runtimes
            .map((r) => r.last_seen_at)
            .filter(Boolean)
            .sort()
            .reverse()[0];
          const boundAgents = agents.filter((a) =>
            machine.runtimes.some((r) => r.id === a.runtime_id)
          );
          const hasPendingUpdate = machine.runtimes.some(
            (r) => r.pending_update_version
          );
          const updateVersion = machine.runtimes.find((r) => r.pending_update_version)?.pending_update_version;

          return (
            <div key={daemonId} className="flex items-start gap-3 text-xs">
              <Tooltip>
                <TooltipTrigger render={
                  <span
                    className={`mt-1 size-2 shrink-0 rounded-full ${isOnline ? "bg-emerald-500" : "bg-muted-foreground/30"}`}
                  />
                } />
                <TooltipContent side="top">{isOnline ? "Online" : "Offline"}</TooltipContent>
              </Tooltip>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">
                    {machine.deviceInfo || daemonId.slice(0, 12)}
                  </span>
                  {hasPendingUpdate && (
                    <Tooltip>
                      <TooltipTrigger render={
                        <span>
                          <Badge variant="outline" className="text-[10px] px-2 py-0 text-amber-500 border-amber-500/30">
                            update
                          </Badge>
                        </span>
                      } />
                      <TooltipContent side="top">Pending update to v{updateVersion}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <div className="text-muted-foreground mt-1">
                  {boundAgents.length > 0
                    ? boundAgents.map((a) => a.name).join(", ")
                    : "No agents"}
                  {" · "}
                  {timeAgo(lastSeen ?? null)}
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
