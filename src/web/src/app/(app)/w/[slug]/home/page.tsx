"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  RotateCcw,
  Loader2,
  Plus,
} from "lucide-react";
import type { AgentLink } from "@alook/shared";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { AgentPreviewCard } from "@/components/agent-preview-card";
import {
  listAgentLinks,
  createAgentLink,
  updateAgentLink,
  deleteAgentLink,
} from "@/lib/api";
import { toast } from "sonner";
import { ApiError } from "@/lib/errors";
import { AgentNode, type AgentNodeData } from "@/components/canvas/agent-node";
import { LinkEdge } from "@/components/canvas/link-edge";
import { LinkSidecar } from "@/components/canvas/link-sidecar";
import { ActiveTasksFloat } from "@/components/canvas/active-tasks-float";
import { UpcomingEventsFloat } from "@/components/canvas/upcoming-events-float";
import { getAutoLayout } from "@/components/canvas/auto-layout";

const nodeTypes = { agent: AgentNode };
const edgeTypes = { link: LinkEdge };

function storageKey(workspaceId: string) {
  return `alook-canvas-positions-${workspaceId}`;
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
  } catch {}
}

function AgentCanvas() {
  const router = useRouter();
  const { agents, runtimes, loading, activeTaskCounts } = useAgentContext();
  const { slug, workspaceId } = useWorkspace();
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [links, setLinks] = useState<AgentLink[]>([]);
  const [linksLoaded, setLinksLoaded] = useState(false);
  const [sidecarLink, setSidecarLink] = useState<AgentLink | null>(null);
  const [sidecarOpen, setSidecarOpen] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const initialLayoutDone = useRef(false);
  const handleMap = useRef<Record<string, { sourceHandle: string; targetHandle: string }>>({});

  // Fetch links
  useEffect(() => {
    if (!workspaceId || loading || agents.length === 0) return;
    let cancelled = false;
    listAgentLinks(workspaceId)
      .then((data) => {
        if (!cancelled) {
          setLinks(data);
          setLinksLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLinksLoaded(true);
      });
    return () => { cancelled = true; };
  }, [workspaceId, loading, agents.length]);

  // Build edges from links
  useEffect(() => {
    if (!linksLoaded) return;

    const nodeMap = new Map(nodes.map((n) => [n.id, n.position]));

    const newEdges: Edge[] = links.map((link) => {
      const stored = handleMap.current[link.id];
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
              setSidecarLink(l);
              setSidecarOpen(true);
            }
          },
        },
        selected: sidecarLink?.id === link.id && sidecarOpen,
      };
    });
    setEdges(newEdges);
    setShowHint(newEdges.length === 0);
  }, [links, linksLoaded, sidecarLink, sidecarOpen, nodes]);

  // Build nodes from agents
  useEffect(() => {
    if (loading || agents.length === 0) return;

    const saved = loadPositions(workspaceId);
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

    if (!hasAnyPosition) {
      // First visit — auto-layout all
      if (linksLoaded) {
        const currentEdges: Edge[] = links.map((link) => ({
          id: link.id,
          source: link.source_agent_id,
          target: link.target_agent_id,
        }));
        newNodes = getAutoLayout(newNodes, currentEdges);
        if (!initialLayoutDone.current) {
          initialLayoutDone.current = true;
          setTimeout(() => fitView({ padding: 0.4, duration: 400 }), 50);
        }
      }
    } else if (newAgentIds.length > 0 && linksLoaded) {
      // Existing positions + some new agents — layout new nodes only
      const fixedNodes = newNodes.filter((n) => validPositions[n.id]);
      const floatingNodes = newNodes.filter((n) => !validPositions[n.id]);
      const currentEdges: Edge[] = links.map((link) => ({
        id: link.id,
        source: link.source_agent_id,
        target: link.target_agent_id,
      }));
      const allLaid = getAutoLayout([...fixedNodes, ...floatingNodes], currentEdges);
      newNodes = newNodes.map((n) => {
        if (validPositions[n.id]) return n;
        const laid = allLaid.find((l) => l.id === n.id);
        return laid ? { ...n, position: laid.position } : n;
      });
    }

    setNodes(newNodes);
  }, [agents, runtimes, activeTaskCounts, slug, loading, workspaceId, linksLoaded, links, fitView]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  const onNodeDragStop = useCallback(() => {
    setNodes((nds) => {
      savePositions(workspaceId, nds);
      return nds;
    });
  }, [workspaceId]);

  const onConnect: OnConnect = useCallback(
    async (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      try {
        const created = await createAgentLink(
          {
            source_agent_id: connection.source,
            target_agent_id: connection.target,
          },
          workspaceId,
        );
        if (connection.sourceHandle || connection.targetHandle) {
          handleMap.current[created.id] = {
            sourceHandle: connection.sourceHandle ?? "right",
            targetHandle: connection.targetHandle ?? "target-left",
          };
        }
        setLinks((prev) => [...prev, created]);
        setShowHint(false);
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.status === 409) toast.error("Link already exists");
          else if (e.status === 400) toast.error("Can't link an agent to itself");
          else toast.error("Failed to create link");
        } else {
          toast.error("Failed to create link");
        }
      }
    },
    [workspaceId],
  );

  const handleSidecarSave = useCallback(
    async (id: string, instruction: string) => {
      try {
        const updated = await updateAgentLink(id, { instruction }, workspaceId);
        setLinks((prev) => prev.map((l) => (l.id === id ? updated : l)));
      } catch {
        toast.error("Failed to update link");
      }
    },
    [workspaceId],
  );

  const handleSidecarDelete = useCallback(
    async (id: string) => {
      try {
        await deleteAgentLink(id, workspaceId);
        setLinks((prev) => prev.filter((l) => l.id !== id));
        setSidecarOpen(false);
      } catch {
        toast.error("Failed to delete link");
      }
    },
    [workspaceId],
  );

  const handleResetLayout = useCallback(() => {
    try {
      localStorage.removeItem(storageKey(workspaceId));
    } catch {}
    const currentEdges: Edge[] = links.map((link) => ({
      id: link.id,
      source: link.source_agent_id,
      target: link.target_agent_id,
    }));
    setNodes((prev) => {
      const laid = getAutoLayout(prev, currentEdges);
      // Animate by adding a transition style
      const animated = laid.map((n) => ({
        ...n,
        style: { ...n.style, transition: "transform 300ms ease-out" },
      }));
      setTimeout(() => {
        setNodes((nds) =>
          nds.map((n) => ({
            ...n,
            style: { ...n.style, transition: undefined },
          })),
        );
        fitView({ padding: 0.4, duration: 400 });
      }, 350);
      return animated;
    });
  }, [links, workspaceId, fitView]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const nodeData = node.data as unknown as AgentNodeData;
      router.push(`/w/${slug}/agents/${nodeData.agent.id}`);
    },
    [router, slug],
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
    <div className="flex-1 relative">
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
        className="absolute bottom-4 left-4 bg-background/80 backdrop-blur-sm rounded-lg ring-1 ring-foreground/5 p-1 flex gap-0.5 animate-[fade-up_300ms_ease-out_both]"
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
        <button
          type="button"
          className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          onClick={handleResetLayout}
        >
          <RotateCcw className="size-4" />
        </button>
      </div>

      {/* No-links hint */}
      {showHint && (
        <div className="absolute bottom-14 left-4 text-xs text-muted-foreground bg-background/80 backdrop-blur-sm rounded-md px-3 py-1.5 ring-1 ring-foreground/5">
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
        <ActiveTasksFloat />
        <UpcomingEventsFloat />
      </div>

      {/* Create agent button */}
      <button
        type="button"
        className="absolute top-4 right-4 size-8 rounded-lg bg-background/80 backdrop-blur-sm ring-1 ring-foreground/5 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors animate-[fade-up_300ms_ease-out_both]"
        style={{ animationDelay: "200ms" }}
        onClick={() => router.push(`/w/${slug}/agents/new`)}
        title="Create new agent"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

function MobileAgentList() {
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

  return (
    <div className="relative flex-1 flex flex-col">
      <div className="flex flex-col gap-1 p-4 overflow-y-auto thin-scrollbar">
        {agents.map((agent) => {
          const rt = runtimes.find((r) => r.id === agent.runtime_id);
          const isOnline = rt?.status === "online";
          return (
            <div
              key={agent.id}
              role="button"
              tabIndex={0}
              className="flex items-center w-full rounded-xl px-3 py-2.5 hover:bg-accent/50 active:bg-accent/70 transition-colors cursor-pointer text-left"
              onClick={() => router.push(`/w/${slug}/agents/${agent.id}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  router.push(`/w/${slug}/agents/${agent.id}`);
                }
              }}
            >
              <AgentPreviewCard
                agent={agent}
                isOnline={isOnline}
                activeTaskCount={activeTaskCounts[agent.id] ?? 0}
              />
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="absolute top-4 right-4 size-8 rounded-lg bg-background/80 backdrop-blur-sm ring-1 ring-foreground/5 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        onClick={() => router.push(`/w/${slug}/agents/new`)}
        title="Create new agent"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const { agents, runtimes, loading } = useAgentContext();
  const { slug, workspaceId } = useWorkspace();
  const isMobile = useIsMobile();

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center animate-[fade-up_400ms_ease-out_both]">
          <p className="text-muted-foreground text-sm">Build your AI studio to get started.</p>
          <Button
            size="sm"
            className="mt-4 glow-border"
            onClick={() => router.push(`/studio/new?workspace_id=${workspaceId}`)}
          >
            Build Studio
          </Button>
        </div>
      </div>
    );
  }

  if (isMobile) {
    return <MobileAgentList />;
  }

  return (
    <ReactFlowProvider>
      <AgentCanvas />
    </ReactFlowProvider>
  );
}
