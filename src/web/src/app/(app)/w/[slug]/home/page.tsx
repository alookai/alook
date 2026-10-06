"use client";

import { useObservedRegion } from "@/lib/observability/regions"
import { viewEvidence, mergeEvidence } from "@/lib/observability/data-source"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type Edge,
  type OnConnect,
  type Connection,
  type NodeChange,
  type EdgeChange,
  applyNodeChanges,
  applyEdgeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Loader2,
  Plus,
  LayoutGrid,
  Circle,
  GitBranch,
  ArrowRight,
  Check,
} from "lucide-react";
import type { Agent, AgentLink } from "@alook/shared";
import { cn } from "@/lib/utils";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace, useWorkspaceOwner, captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions, runWorkspaceRequest } from "@/contexts/workspace-context";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAgentChatSheet } from "@/contexts/agent-chat-sheet-context";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AgentPreviewCard } from "@/components/agent-preview-card";
import { AnimatedAvatar } from "@/components/avatar";
import {
  createAgentLink,
  updateAgentLink,
  deleteAgentLink,
  createMachineToken,
} from "@/lib/api";
import { toast } from "sonner";
import { cliCmd } from "@/lib/utils";
import { ApiError, isAbortError } from "@/lib/errors";
import { trackAgentLinkCreated, trackCanvasLayoutChanged } from "@/lib/analytics";
import { AgentNode, type AgentNodeData } from "@/components/canvas/agent-node";
import { LinkEdge } from "@/components/canvas/link-edge";
import { LinkSidecar } from "@/components/canvas/link-sidecar";
import { ActiveTasksFloat } from "@/components/canvas/active-tasks-float";
import { UpcomingEventsFloat } from "@/components/canvas/upcoming-events-float";
import { getAutoLayout, type LayoutType } from "@/components/canvas/auto-layout";

const nodeTypes = { agent: AgentNode };
const edgeTypes = { link: LinkEdge };

function storageKey(workspaceId: string) {
  return `alook-canvas-positions-${workspaceId}`;
}

function layoutStorageKey(workspaceId: string) {
  return `alook-canvas-layout-${workspaceId}`;
}

function loadLayoutType(workspaceId: string): LayoutType {
  try {
    const raw = localStorage.getItem(layoutStorageKey(workspaceId));
    if (raw === "star" || raw === "tree" || raw === "flow") return raw;
  } catch {}
  return "tree";
}

function saveLayoutType(workspaceId: string, layout: LayoutType) {
  try {
    localStorage.setItem(layoutStorageKey(workspaceId), layout);
  } catch {}
}

function loadPositions(workspaceId: string): Record<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePositions(workspaceId: string, nodes: Node[]) {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    positions[n.id] = n.position;
  }
  try {
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(positions));
  } catch { }
}

function AgentCanvas({ onAgentClick }: { onAgentClick?: (agent: Agent) => void }) {
  const router = useRouter();
  const { agents, runtimes, loading, activeTaskCounts, agentLinks, pendingNewAgent, clearPendingNewAgent } = useAgentContext();
  const owner = useWorkspaceOwner();
  useObservedRegion("agents", !loading, mergeEvidence([viewEvidence(agents), viewEvidence(agentLinks), viewEvidence(runtimes)]));
  const { slug, workspaceId } = owner;
  const source = useWorkspaceViewSource(owner, "canvas", true);
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasScope = `${owner.application.userId}:${workspaceId}`;
  const layoutTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const laterLayout = useCallback((callback: () => void, delay: number) => {
    const assertView = source.assertActive;
    const timer = setTimeout(() => {
      layoutTimers.current.delete(timer);
      try { assertView(); } catch { return; }
      callback();
    }, delay);
    layoutTimers.current.add(timer);
  }, [source.assertActive]);
  useEffect(() => {
    const timers = layoutTimers.current;
    return () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };
  }, []);

  const geometry = useCreateAtom<Node[]>([]);
  const [nodeGeometry, setGeometry] = useAtom(geometry);
  const nodes = useMemo<Node[]>(() => nodeGeometry.flatMap((node, index) => {
    const agent = agents.find((row) => row.id === node.id);
    return agent ? [{ ...node, data: { agent, runtimes, activeTaskCount: activeTaskCounts[node.id] ?? 0, slug, index } satisfies AgentNodeData }] : [];
  }), [nodeGeometry, agents, runtimes, activeTaskCounts, slug]);
  const setNodes = useCallback((update: Node[] | ((nodes: Node[]) => Node[])) => setGeometry((current) => {
    const next = typeof update === "function" ? update(current) : update;
    return next.map(({ data: _data, ...node }) => ({ ...node, data: {} }));
  }), [setGeometry]);
  const links = agentLinks;
  const linksLoaded = !loading;
  const [sidecarLinkId, setSidecarLinkId] = useAtom(useCreateAtom<string | null>(null));
  const sidecarLink = links.find((link) => link.id === sidecarLinkId) ?? null;
  const [sidecarOpen, setSidecarOpen] = useAtom(useCreateAtom(false));
  const showHint = linksLoaded && links.length === 0;
  const [layoutType, setLayoutType] = useAtom(useCreateAtom<LayoutType>("tree"));
  const initialLayoutDone = useRef(false);
  const [handles, setHandles] = useAtom(useCreateAtom<Record<string, { sourceHandle: string; targetHandle: string }>>({}));
  const [edgeView, setEdgeView] = useAtom(useCreateAtom<Record<string, { selected?: boolean; hidden?: boolean }>>({}));
  useEffect(() => { setLayoutType(loadLayoutType(`${owner.application.userId}:${workspaceId}`)); }, [owner, workspaceId, setLayoutType]);

  const edges = useMemo<Edge[]>(() => {
    if (!linksLoaded) return [];

    const nodeMap = new Map(nodes.map((n) => [n.id, n.position]));

    const newEdges: Edge[] = links.map((link) => {
      const stored = handles[link.id];
      let sourceHandle = stored?.sourceHandle;
      let targetHandle = stored?.targetHandle;

      if (!sourceHandle || !targetHandle) {
        const sp = nodeMap.get(link.source_agent_id);
        const tp = nodeMap.get(link.target_agent_id);
        if (sp && tp) {
          const dx = tp.x - sp.x;
          const dy = tp.y - sp.y;
          if (Math.abs(dx) >= Math.abs(dy)) {
            sourceHandle = dx >= 0 ? "right" : "left";
            targetHandle = dx >= 0 ? "target-left" : "target-right";
          } else {
            sourceHandle = dy >= 0 ? "bottom" : "top";
            targetHandle = dy >= 0 ? "target-top" : "target-bottom";
          }
        } else {
          sourceHandle = "right";
          targetHandle = "target-left";
        }
      }

      return {
        id: link.id,
        source: link.source_agent_id,
        target: link.target_agent_id,
        sourceHandle,
        targetHandle,
        type: "link",
        data: {
          instruction: link.instruction,
          onEdgeClick: (edgeId: string) => {
            const l = links.find((lk) => lk.id === edgeId);
            if (l) {
              setSidecarLinkId(l.id);
              setSidecarOpen(true);
            }
          },
        },
        selected: sidecarLink?.id === link.id && sidecarOpen,
        ...edgeView[link.id],
      };
    });
    return newEdges;
  }, [links, linksLoaded, sidecarLink, sidecarOpen, nodes, handles, edgeView, setSidecarLinkId, setSidecarOpen]);

  // Build nodes from agents
  useEffect(() => {
    if (loading || agents.length === 0) return;

    const saved = { ...loadPositions(canvasScope), ...Object.fromEntries(geometry.get().map((node) => [node.id, node.position])) };
    // Filter out stale positions
    const agentIds = new Set(agents.map((a) => a.id));
    const validPositions: Record<string, { x: number; y: number }> = {};
    for (const [id, pos] of Object.entries(saved)) {
      if (agentIds.has(id)) validPositions[id] = pos;
    }

    let newNodes: Node[] = agents.map((agent, index) => ({
      id: agent.id,
      type: "agent",
      position: validPositions[agent.id] ?? { x: 0, y: 0 },
      data: {
        agent,
        runtimes,
        activeTaskCount: activeTaskCounts[agent.id] ?? 0,
        slug,
        index,
      } satisfies AgentNodeData,
    }));

    const hasAnyPosition = Object.keys(validPositions).length > 0;
    const newAgentIds = agents.filter((a) => !validPositions[a.id]).map((a) => a.id);

    // Case 1: No saved positions and links not loaded yet — wait for links before setting nodes
    if (!hasAnyPosition && !linksLoaded) return;

    // Case 2: Some saved positions but new agents need layout — only show positioned nodes until links load
    if (hasAnyPosition && newAgentIds.length > 0 && !linksLoaded) {
      newNodes = newNodes.filter((n) => validPositions[n.id]);
    }

    if (!hasAnyPosition) {
      // First visit — auto-layout all
      if (linksLoaded) {
        const currentEdges: Edge[] = links.map((link) => ({
          id: link.id,
          source: link.source_agent_id,
          target: link.target_agent_id,
        }));
        newNodes = getAutoLayout(newNodes, currentEdges, layoutType);
        if (!initialLayoutDone.current) {
          initialLayoutDone.current = true;
          laterLayout(() => fitView({ padding: 0.4, duration: 400 }), 50);
        }
        if (pendingNewAgent) clearPendingNewAgent();
      }
    } else if (newAgentIds.length > 0 && linksLoaded) {
      // Existing positions + some new agents — position relative to parent
      newNodes = newNodes.map((n) => {
        if (validPositions[n.id]) return n;

        // Find parent: use pendingNewAgent hint or scan links
        let parentId: string | undefined;
        if (pendingNewAgent && n.id === pendingNewAgent.agentId) {
          parentId = pendingNewAgent.parentAgentId;
        }
        if (!parentId) {
          const linkedEdge = links.find(
            (l) => (l.source_agent_id === n.id && validPositions[l.target_agent_id]) ||
                   (l.target_agent_id === n.id && validPositions[l.source_agent_id])
          );
          if (linkedEdge) {
            parentId = linkedEdge.source_agent_id === n.id
              ? linkedEdge.target_agent_id
              : linkedEdge.source_agent_id;
          }
        }

        const siblingIndex = newAgentIds.indexOf(n.id);
        if (parentId && validPositions[parentId]) {
          const pp = validPositions[parentId];
          let pos: { x: number; y: number };
          switch (layoutType) {
            case "tree":
              pos = { x: pp.x + siblingIndex * 300, y: pp.y + 200 };
              break;
            case "flow":
              pos = { x: pp.x + 350, y: pp.y + siblingIndex * 150 };
              break;
            default: // star
              pos = { x: pp.x + 300, y: pp.y + 100 + siblingIndex * 150 };
              break;
          }
          return { ...n, position: pos };
        }

        // Fallback: centroid of all existing nodes + offset
        const positions = Object.values(validPositions);
        const cx = positions.reduce((s, p) => s + p.x, 0) / positions.length;
        const cy = positions.reduce((s, p) => s + p.y, 0) / positions.length;
        return { ...n, position: { x: cx + 350 + siblingIndex * 300, y: cy } };
      });

      savePositions(canvasScope, newNodes);
      laterLayout(() => fitView({ padding: 0.4, duration: 400, includeHiddenNodes: false }), 50);
      if (pendingNewAgent) clearPendingNewAgent();
    }

    setNodes(newNodes);
  }, [agents, runtimes, activeTaskCounts, slug, loading, canvasScope, linksLoaded, links, fitView, layoutType, pendingNewAgent, clearPendingNewAgent, geometry, setNodes, laterLayout]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, [setNodes]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const updated = applyEdgeChanges(changes, edges);
    setEdgeView(Object.fromEntries(updated.map((edge) => [edge.id, { selected: edge.selected, hidden: edge.hidden }])));
  }, [edges, setEdgeView]);

  const onNodeDragStop = useCallback(() => {
    setNodes((nds) => {
      savePositions(canvasScope, nds);
      return nds;
    });
  }, [canvasScope, setNodes]);

  const linkKey = owner.key("agent-links");
  const linkCommand = useMutation({ meta: { observabilityAction: "agent.link.command" }, mutationKey: owner.key("agent-link-command"), scope: { id: JSON.stringify(owner.key("agent-link-command")) },
    mutationFn: async ({ action, token }: { action: { kind: "create"; source: string; target: string } | { kind: "update"; id: string; instruction: string } | { kind: "delete"; id: string }; token: ReturnType<typeof captureWorkspaceOwner> }) => {
      const assert = () => assertWorkspaceOwner(token), qc = owner.queryClient;
      assert();
      await qc.cancelQueries({ queryKey: linkKey, exact: true });
      assert();
      const resource = qc.getQueryCache().find({ queryKey: linkKey, exact: true }), baseline = resource?.state.data as AgentLink[] | undefined;
      const original = () => resource && qc.getQueryCache().find({ queryKey: linkKey, exact: true }) === resource;
      const options = workspaceRequestOptions(token);
      let id: string;
      try {
        if (action.kind === "create") {
          const confirmed = await createAgentLink({ source_agent_id: action.source, target_agent_id: action.target }, workspaceId, options);
          assert();
          id = confirmed.id;
          if (original() && resource!.state.data === baseline) qc.setQueryData<AgentLink[]>(linkKey, (rows) => [...(rows ?? []).filter((row) => row.id !== confirmed.id), confirmed]);
        } else if (action.kind === "update") {
          const confirmed = await updateAgentLink(action.id, { instruction: action.instruction }, workspaceId, options);
          assert();
          id = action.id;
          const old = baseline?.find((row) => row.id === action.id);
          if (original()) qc.setQueryData<AgentLink[]>(linkKey, (rows) => rows?.map((row) => row.id === action.id && row.instruction === old?.instruction ? { ...row, instruction: confirmed.instruction } : row));
        } else {
          await deleteAgentLink(action.id, workspaceId, options);
          assert();
          id = action.id;
          if (original() && resource!.state.data === baseline) qc.setQueryData<AgentLink[]>(linkKey, (rows) => rows?.filter((row) => row.id !== action.id));
        }
        await qc.invalidateQueries({ queryKey: linkKey, exact: true });
        assert();
        return { id };
      } catch (error) { assert(); throw error; }
    },
  });
  const onConnect: OnConnect = useCallback(async (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const assertView = source.assertActive;
    try {
      const created = await linkCommand.mutateAsync({ action: { kind: "create", source: connection.source, target: connection.target }, token: captureWorkspaceOwner(owner) });
      assertView();
      trackAgentLinkCreated({ source_agent: connection.source, target_agent: connection.target });
      if (connection.sourceHandle || connection.targetHandle) setHandles((current) => ({ ...current, [created.id]: { sourceHandle: connection.sourceHandle ?? "right", targetHandle: connection.targetHandle ?? "target-left" } }));
    } catch (error) {
      try { assertView(); } catch { return; }
      if (isAbortError(error)) return;
      if (error instanceof ApiError && error.status === 409) toast.error("Link already exists");
      else if (error instanceof ApiError && error.status === 400) toast.error("Can't link an agent to itself");
      else toast.error("Failed to create link");
    }
  }, [source.assertActive, linkCommand, owner, setHandles]);
  const handleSidecarSave = useCallback(async (id: string, instruction: string) => {
    const assertView = source.assertActive;
    try {
      await linkCommand.mutateAsync({ action: { kind: "update", id, instruction }, token: captureWorkspaceOwner(owner) });
      assertView();
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error("Failed to update link");
    }
  }, [source.assertActive, linkCommand, owner]);
  const handleSidecarDelete = useCallback(async (id: string) => {
    const assertView = source.assertActive;
    try {
      await linkCommand.mutateAsync({ action: { kind: "delete", id }, token: captureWorkspaceOwner(owner) });
      assertView();
      setSidecarOpen(false);
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error("Failed to delete link");
    }
  }, [source.assertActive, linkCommand, owner, setSidecarOpen]);


  const handleLayoutChange = useCallback((newLayout: LayoutType) => {
    trackCanvasLayoutChanged({ layout_type: newLayout });
    setLayoutType(newLayout);
    saveLayoutType(canvasScope, newLayout);
    try {
      localStorage.removeItem(storageKey(canvasScope));
    } catch {}
    const currentEdges: Edge[] = links.map((link) => ({
      id: link.id,
      source: link.source_agent_id,
      target: link.target_agent_id,
    }));
    setNodes((prev) => {
      const laid = getAutoLayout(prev, currentEdges, newLayout);
      const animated = laid.map((n) => ({
        ...n,
        style: { ...n.style, transition: "transform 300ms ease-out" },
      }));
      laterLayout(() => {
        setNodes((nds) => {
          const final = nds.map((n) => ({
            ...n,
            style: { ...n.style, transition: undefined },
          }));
          savePositions(canvasScope, final);
          return final;
        });
        fitView({ padding: 0.4, duration: 400 });
      }, 350);
      return animated;
    });
  }, [links, canvasScope, fitView, setNodes, setLayoutType, laterLayout]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const nodeData = node.data as unknown as AgentNodeData;
      setSidecarOpen(false);
      if (onAgentClick) {
        onAgentClick(nodeData.agent);
      } else {
        router.push(`/w/${slug}/agents/${nodeData.agent.id}`);
      }
    },
    [setSidecarOpen, onAgentClick, router, slug],
  );

  const connectionLineStyle = useMemo(
    () => ({
      stroke: "var(--color-primary)",
      strokeWidth: 1.5,
      strokeDasharray: "6 4",
      opacity: 0.5,
    }),
    [],
  );

  return (
    <div ref={canvasRef} className="flex-1 relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onNodeDragStop={onNodeDragStop}
        connectionLineStyle={connectionLineStyle}
        fitView
        fitViewOptions={{ padding: 0.4, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={2.5}
        zoomOnScroll
        panOnScroll={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="var(--color-border)" />
      </ReactFlow>

      {/* Custom floating toolbar */}
      <div
        className="absolute bottom-4 left-4 z-40 bg-background/80 backdrop-blur-sm rounded-lg ring-1 ring-foreground/5 p-1 flex gap-1 animate-[fade-up_300ms_ease-out_both]"
        style={{ animationDelay: "200ms" }}
      >
        <button
          type="button"
          className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          onClick={() => zoomIn()}
        >
          <ZoomIn className="size-4" />
        </button>
        <button
          type="button"
          className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          onClick={() => zoomOut()}
        >
          <ZoomOut className="size-4" />
        </button>
        <button
          type="button"
          className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          onClick={() => fitView({ padding: 0.4, duration: 400 })}
        >
          <Maximize2 className="size-4" />
        </button>

        <div className="w-px h-5 bg-foreground/10 mx-1 self-center" />

        <Popover>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    />
                  }
                >
                  <LayoutGrid className="size-3.5" />
                </PopoverTrigger>
              }
            />
            <TooltipContent side="top">Layout</TooltipContent>
          </Tooltip>
          <PopoverContent className="w-36 p-1" align="start" side="top" sideOffset={8}>
            {([
              { type: "star" as const, label: "Star", icon: Circle },
              { type: "tree" as const, label: "Tree", icon: GitBranch },
              { type: "flow" as const, label: "Flow", icon: ArrowRight },
            ]).map(({ type, label, icon: Icon }) => (
              <button
                key={type}
                type="button"
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-2 rounded-md text-sm transition-colors",
                  layoutType === type
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                )}
                onClick={() => handleLayoutChange(type)}
              >
                <Icon className="size-3.5" />
                <span className="flex-1 text-left">{label}</span>
                {layoutType === type && <Check className="size-3.5" />}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>

      {/* No-links hint */}
      {showHint && (
        <div className="absolute bottom-14 left-4 z-40 text-xs text-muted-foreground bg-background/80 backdrop-blur-sm rounded-md px-3 py-2 ring-1 ring-foreground/5">
          Drag between agent handles to create relationships.
        </div>
      )}

      <LinkSidecar
        open={sidecarOpen}
        onOpenChange={setSidecarOpen}
        link={sidecarLink}
        agents={agents}
        onSave={handleSidecarSave}
        onDelete={handleSidecarDelete}
      />

      <div className="absolute bottom-4 right-4 z-10 flex flex-wrap justify-end items-end gap-2">
        <UpcomingEventsFloat />
        <ActiveTasksFloat />
      </div>

      {/* Create agent button */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="absolute top-4 right-4 z-40 size-8 rounded-lg bg-background/80 backdrop-blur-sm ring-1 ring-foreground/5 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors animate-[fade-up_300ms_ease-out_both]"
              style={{ animationDelay: "200ms" }}
              onClick={() => router.push(`/w/${slug}/agents/new`)}
            />
          }
        >
          <Plus className="size-4" />
        </TooltipTrigger>
        <TooltipContent>Create new agent</TooltipContent>
      </Tooltip>
    </div>
  );
}

function MobileAgentList({ onAgentClick }: { onAgentClick?: (agent: Agent) => void }) {
  const router = useRouter();
  const { agents, runtimes, loading, activeTaskCounts } = useAgentContext();
  const { slug } = useWorkspace();

  if (loading) {
    return (
      <div className="flex flex-col gap-1 p-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="animate-pulse rounded-xl bg-muted h-15" />
        ))}
      </div>
    );
  }

  const handleClick = (agent: Agent) => {
    if (onAgentClick) {
      onAgentClick(agent);
    } else {
      router.push(`/w/${slug}/agents/${agent.id}`);
    }
  };

  return (
    <div className="relative flex-1 flex flex-col min-h-0">
      <div className="flex flex-col gap-1 p-4 overflow-y-auto thin-scrollbar flex-1 min-h-0">
        {agents.map((agent) => {
          const rt = runtimes.find((r) => r.id === agent.runtime_id);
          const isOnline = rt?.status === "online";
          return (
            <div
              key={agent.id}
              role="button"
              tabIndex={0}
              className="flex items-center gap-3 w-full rounded-xl px-3 py-2 hover:bg-accent/50 active:bg-accent/70 transition-colors cursor-pointer text-left"
              onClick={() => handleClick(agent)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleClick(agent);
                }
              }}
            >
              <AnimatedAvatar seed={agent.id} avatarUrl={agent.avatar_url} size={36} className="shrink-0 rounded-xl" isHovered={false} isWorking={isOnline && (activeTaskCounts[agent.id] ?? 0) > 0} />
              <div className="min-w-0 flex-1">
                <AgentPreviewCard
                  agent={agent}
                  isOnline={isOnline}
                  activeTaskCount={activeTaskCounts[agent.id] ?? 0}
                />
              </div>
            </div>
          );
        })}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="absolute top-4 right-4 size-8 rounded-lg bg-background/80 backdrop-blur-sm ring-1 ring-foreground/5 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              onClick={() => router.push(`/w/${slug}/agents/new`)}
            />
          }
        >
          <Plus className="size-4" />
        </TooltipTrigger>
        <TooltipContent>Create new agent</TooltipContent>
      </Tooltip>
    </div>
  );
}

function ConnectComputerCard({ workspaceId }: { workspaceId: string }) {
  const owner = useWorkspaceOwner();
  const source = useWorkspaceViewSource(owner, "connect-computer", true);
  const pairing = useQuery({ queryKey: owner.key("machine-pairing", "cli"), gcTime: 0, staleTime: Infinity, retry: false,
    queryFn: ({ signal }) => runWorkspaceRequest(owner, (options) => createMachineToken("cli", workspaceId, options), signal),
  });
  const command = `${cliCmd()} register --token ${pairing.data?.token ?? ""}`;

  const copy = async () => {
    const assertView = source.assertActive;
    try {
      assertView();
      await navigator.clipboard.writeText(command);
      assertView();
      toast.success("Copied to clipboard");
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error("Failed to copy command");
    }
  };

  return (
    <div className="rounded-xl bg-muted/40 p-4 space-y-3">
      <h3 className="text-sm font-semibold">Connect a computer</h3>
      <p className="text-xs text-muted-foreground">
        Run this command in your terminal to link your machine.
      </p>
      {pairing.isPending ? (
        <div className="rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground animate-pulse">
          Generating token...
        </div>
      ) : pairing.isError ? (
        <Button size="sm" onClick={() => void pairing.refetch()}>Retry generating token</Button>
      ) : (
        <>
          <div
            className="rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground cursor-pointer hover:bg-muted/80 transition-colors break-all"
            onClick={copy}
          >
            {command}
          </div>
          <Button size="sm" onClick={copy} className="w-full">
            Copy Command
          </Button>
        </>
      )}
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const { agents, runtimes, loading } = useAgentContext();
  const { workspaceId } = useWorkspace();
  const isMobile = useIsMobile();
  const { openAgentChat } = useAgentChatSheet();

  const handleAgentClick = useCallback((agent: Agent) => {
    openAgentChat(agent.id);
  }, [openAgentChat]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const onlineRuntimes = runtimes.filter((r) => r.status === "online");
  const hasComputer = onlineRuntimes.length > 0;

  if (agents.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-sm space-y-6 animate-[fade-up_400ms_ease-out_both]">
          {!hasComputer && (
            <ConnectComputerCard workspaceId={workspaceId} />
          )}
          <div className="text-center">
            <p className="text-muted-foreground text-sm">Build your AI company</p>
            <Button
              size="sm"
              className="mt-4 glow-border"
              onClick={() => router.push(`/studio/new?workspace_id=${workspaceId}`)}
            >
              Get Started
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (isMobile) {
    return <MobileAgentList onAgentClick={handleAgentClick} />;
  }

  return (
    <ReactFlowProvider>
      <AgentCanvas onAgentClick={handleAgentClick} />
    </ReactFlowProvider>
  );
}
