"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2 } from "lucide-react";
import { getWorkspaceOverview, type WorkspaceOverview } from "@/lib/api";
import { AgentOverview } from "./_components/agent-overview";
import { RecentActivity } from "./_components/recent-activity";
import { CalendarOverview } from "./_components/calendar-overview";
import { DailyQuote } from "./_components/daily-quote";

export default function HomePage() {
  const router = useRouter();
  const { agents, runtimes, loading, activeTaskCounts } = useAgentContext();
  const { slug, workspaceId } = useWorkspace();
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);

  useEffect(() => {
    if (loading || agents.length === 0) return;
    let cancelled = false;
    setOverviewLoading(true);
    getWorkspaceOverview(workspaceId)
      .then((data) => {
        if (!cancelled) setOverview(data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setOverviewLoading(false);
      });
    return () => { cancelled = true; };
  }, [loading, agents.length, workspaceId]);

  const refreshOverview = useCallback(() => {
    getWorkspaceOverview(workspaceId)
      .then((data) => setOverview(data))
      .catch(() => {});
  }, [workspaceId]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (agents.length === 0) {
    const hasOnline = runtimes.some((r) => r.status === "online");
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center animate-[fade-up_400ms_ease-out_both]">
          {runtimes.length === 0 ? (
            <>
              <p className="text-muted-foreground text-sm">Connect a machine to run your agents.</p>
              <Button
                size="sm"
                className="mt-4 glow-border"
                onClick={() => router.push(`/w/${slug}/runtimes?connect`)}
              >
                Connect Machine
              </Button>
            </>
          ) : !hasOnline ? (
            <>
              <p className="text-muted-foreground text-sm">Start the daemon on your machine to bring it online.</p>
              <Button
                size="sm"
                className="mt-4 glow-border"
                onClick={() => router.push(`/w/${slug}/runtimes`)}
              >
                Bring Machine Online
              </Button>
            </>
          ) : (
            <>
              <p className="text-muted-foreground text-sm">Your machine is ready. Create your first agent to get started.</p>
              <Button
                size="sm"
                className="mt-4 glow-border"
                onClick={() => router.push(`/w/${slug}/agents/new`)}
              >
                Create Agent
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (overviewLoading || !overview) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 lg:p-6 space-y-4">
          <Skeleton className="h-48 rounded-xl" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-44 rounded-xl" />
            <Skeleton className="h-44 rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden">
      <div className="flex min-h-full flex-col gap-4 p-4 lg:h-full lg:min-h-[600px] lg:p-6">
        <AgentOverview
          agents={agents}
          runtimes={runtimes}
          activeTaskCounts={activeTaskCounts}
          overview={overview}
        />
        <div className="grid gap-4 lg:grid-cols-2 lg:flex-1 lg:min-h-0 lg:auto-rows-fr">
          <RecentActivity overview={overview} agents={agents} workspaceId={workspaceId} onRefresh={refreshOverview} />
          <CalendarOverview overview={overview} agents={agents} />
        </div>
        <div className="shrink-0">
          <DailyQuote />
        </div>
      </div>
    </div>
  );
}
