"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useWorkspace } from "@/contexts/workspace-context";
import { getTrace, type TraceTask } from "@/lib/api";
import { trackThreadViewed } from "@/lib/analytics";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft } from "lucide-react";
import { AvatarRenderer, parseAvatarUrl } from "@/components/avatar";

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDuration(createdAt: string, completedAt: string | null): string | null {
  if (!completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(createdAt).getTime();
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds >= 3600) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  if (totalSeconds >= 60) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}m ${s}s`;
  }
  return `${totalSeconds}s`;
}

function StatusDot({ status }: { status: string }) {
  const colorClass =
    status === "completed"
      ? "bg-[oklch(0.72_0.19_145)]"
      : status === "failed"
        ? "bg-destructive"
        : status === "running"
          ? "bg-primary animate-pulse"
          : "bg-muted-foreground/40";
  return <span className={`size-1.5 rounded-full shrink-0 ${colorClass}`} />;
}

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  dispatched: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  superseded: "Cancelled",
};

function AgentAvatar({ name, avatarUrl, size = 14 }: { name?: string; avatarUrl?: string | null; size?: number }) {
  const config = parseAvatarUrl(avatarUrl);
  if (config) return <AvatarRenderer config={config} size={size} className="rounded-full shrink-0" />;
  return (
    <span
      className="flex items-center justify-center rounded-full bg-secondary text-[8px] font-medium shrink-0"
      style={{ width: size, height: size }}
    >
      {(name ?? "?").charAt(0).toUpperCase()}
    </span>
  );
}

interface TreeNode extends TraceTask {
  children: TreeNode[];
  depth: number;
}

function buildTree(tasks: TraceTask[]): TreeNode[] {
  const nodeMap = new Map<string, TreeNode>();
  for (const t of tasks) {
    nodeMap.set(t.id, { ...t, children: [], depth: 0 });
  }

  const roots: TreeNode[] = [];
  for (const node of nodeMap.values()) {
    if (node.parent_task_id && nodeMap.has(node.parent_task_id)) {
      const parent = nodeMap.get(node.parent_task_id)!;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  function setDepth(node: TreeNode, depth: number) {
    node.depth = depth;
    for (const child of node.children) {
      setDepth(child, depth + 1);
    }
  }
  for (const root of roots) setDepth(root, 0);

  return roots;
}

function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  function walk(node: TreeNode) {
    result.push(node);
    for (const child of node.children) walk(child);
  }
  for (const n of nodes) walk(n);
  return result;
}

function TaskNode({ node, slug }: { node: TreeNode; slug: string }) {
  const duration = formatDuration(node.created_at, node.completed_at);

  return (
    <Link
      href={`/w/${slug}/agents/${node.agent_id}?task=${node.id}&conv=${node.conversation_id}`}
      className="block px-4 py-3 border-b border-border/30 hover:bg-accent/30 transition-colors duration-150 cursor-pointer"
      style={{ paddingLeft: `${1 + node.depth * 1.5}rem` }}
    >
      <div className="flex items-center gap-2">
        <AgentAvatar name={node.agent?.name} avatarUrl={node.agent?.avatarUrl} size={32} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-foreground truncate flex-1 min-w-0">
              {node.prompt.split("\n")[0]}
            </span>
            <Tooltip>
              <TooltipTrigger render={<span className="text-xs text-muted-foreground shrink-0 ml-2" />}>
                {relativeTime(node.created_at)}
              </TooltipTrigger>
              <TooltipContent>{new Date(node.created_at).toLocaleString()}</TooltipContent>
            </Tooltip>
          </div>
          <div className="flex items-center gap-1.5">
            {node.agent?.name && (
              <>
                <span className="text-xs font-medium text-muted-foreground">{node.agent.name}</span>
                <span className="text-muted-foreground/40">&middot;</span>
              </>
            )}
            <StatusDot status={node.status} />
            <span className="text-xs text-muted-foreground">{STATUS_LABELS[node.status] ?? node.status}</span>
            {duration && (
              <>
                <span className="text-muted-foreground/40">&middot;</span>
                <span className="text-xs text-muted-foreground">{duration}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function TraceDetailPage() {
  const params = useParams();
  const { slug, workspaceId } = useWorkspace();
  const traceId = params.traceId as string;

  const [tasks, setTasks] = useState<TraceTask[]>([]);
  const [channel, setChannel] = useState("default");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getTrace(traceId, workspaceId)
      .then((data) => {
        setTasks(data.tasks);
        setChannel(data.channel);
        const agentIds = new Set(data.tasks.map((t: TraceTask) => t.agent_id));
        const rootStatus = data.tasks.find((t: TraceTask) => !t.parent_task_id)?.status ?? "unknown";
        trackThreadViewed({ agent_count: agentIds.size, status: rootStatus });
      })
      .catch(() => { })
      .finally(() => setLoading(false));
  }, [traceId, workspaceId]);

  const tree = buildTree(tasks);
  const flat = flattenTree(tree);

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2.5 border-b border-border/30">
        <Link
          href={`/w/${slug}/threads`}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
        </Link>
        <span className="text-xs text-muted-foreground">#{channel}</span>
      </div>

      <div className="flex-1 overflow-y-auto thin-scrollbar">
        {loading ? (
          <div className="flex flex-col">
            {[40, 55, 48].map((w, i) => (
              <div key={i} className="px-4 py-3 border-b border-border/30">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-3.5 w-4 rounded-full shrink-0" />
                  <Skeleton className="h-3.5 rounded" style={{ width: `${w}%` }} />
                  <Skeleton className="h-2.5 w-10 rounded shrink-0 ml-auto" />
                </div>
                <div className="flex items-center gap-1.5 mt-1 ml-5.5">
                  <Skeleton className="h-2.5 w-20 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        ) : flat.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">Trace not found</p>
          </div>
        ) : (
          <div className="flex flex-col animate-[fade-up_400ms_ease-out_both]">
            {flat.map((node) => (
              <TaskNode key={node.id} node={node} slug={slug} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
