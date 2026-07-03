"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bot, Mail, Send, Users, Monitor, Zap } from "lucide-react";
import type { Agent, AgentRuntime } from "@alook/shared";
import type { WorkspaceOverview } from "@/lib/api";

interface QuickStatsProps {
  agents: Agent[];
  runtimes: AgentRuntime[];
  activeTaskCounts: Record<string, number>;
  overview: WorkspaceOverview;
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  sub?: string;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <p className="text-2xl font-semibold leading-none tracking-tight">{value}</p>
            {sub && <Badge variant="secondary" className="text-[10px] px-2 h-4 font-normal">{sub}</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground truncate">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function QuickStatsRow({ agents, runtimes, activeTaskCounts, overview }: QuickStatsProps) {
  const machineStatus = new Map<string, boolean>();
  for (const r of runtimes) {
    const key = r.daemon_id ?? r.id;
    machineStatus.set(key, machineStatus.get(key) || r.status === "online");
  }
  const totalMachines = machineStatus.size;
  const onlineMachines = [...machineStatus.values()].filter(Boolean).length;
  const totalActiveTasks = Object.values(activeTaskCounts).reduce((a, b) => a + b, 0);
  const onlineAgents = agents.filter((a) => {
    const rt = runtimes.find((r) => r.id === a.runtime_id);
    return rt?.status === "online";
  }).length;

  return (
    <div className="grid gap-3 grid-cols-2 sm:grid-cols-6">
      <StatCard
        icon={Monitor}
        label="Machines"
        value={`${onlineMachines}/${totalMachines}`}
        sub="online"
      />
      <StatCard
        icon={Bot}
        label="Agents"
        value={agents.length}
        sub={`${onlineAgents} online`}
      />
      <StatCard
        icon={Users}
        label="Members"
        value={overview.members.length}
        sub={overview.pending_invites > 0 ? `${overview.pending_invites} pending` : undefined}
      />
      <StatCard
        icon={Zap}
        label="Active Tasks"
        value={totalActiveTasks}
        sub={overview.task_stats.queued > 0 ? `${overview.task_stats.queued} queued` : undefined}
      />
      <StatCard
        icon={Send}
        label="Emails Sent"
        value={overview.email_stats.outbound}
        sub={`${overview.email_stats.unread} unread`}
      />
      <StatCard
        icon={Mail}
        label="Custom Emails"
        value={overview.email_accounts.length}
      />
    </div>
  );
}
