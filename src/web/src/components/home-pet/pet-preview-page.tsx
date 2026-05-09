"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Agent, AgentRuntime } from "@alook/shared";
import {
  ArrowLeftRight,
  CalendarDays,
  CircleDot,
  GitBranch,
  Home,
  Inbox,
  Maximize2,
  Minus,
  Monitor,
  Plus,
  RotateCcw,
  Search,
  Settings,
  SunMoon,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { GradientBackground } from "@/components/gradient-background";
import { Logo } from "@/components/logo";
import { AgentNode, type AgentNodeData } from "@/components/canvas/agent-node";
import { LinkEdge } from "@/components/canvas/link-edge";
import { AnimatedAvatar, parseAvatarUrl, serializeAvatarConfig } from "@/components/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CloudCodeMonsterPet,
  CloudCodeMonsterPresetPreview,
  CLOUD_CODE_MONSTER_PET_PRESETS,
  CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
  getCloudCodeMonsterPreset,
  readCloudCodeMonsterPetPresetId,
  writeCloudCodeMonsterPetPresetId,
} from "@/components/home-pet/cloud-code-monster-pet";
import { WorkspaceProvider } from "@/contexts/workspace-context";
import { cn } from "@/lib/utils";

type PreviewPage = "home" | "other";

const nodeTypes = { agent: AgentNode };
const edgeTypes = { link: LinkEdge };
const now = "2026-05-07T00:00:00.000Z";
const previewPetInitialPosition = { x: 640, y: 330 };

function avatar(shape: string, eye: string, nose: string, bg: number) {
  return serializeAvatarConfig({ shape, eye, nose, bg });
}

const previewRuntime: AgentRuntime = {
  id: "rt_preview",
  workspace_id: "ws_preview",
  daemon_id: "daemon_preview",
  runtime_mode: "local",
  provider: "codex",
  status: "online",
  device_info: "MacBook Preview",
  metadata: {},
  last_seen_at: now,
  created_at: now,
  updated_at: now,
};

const previewAgents: Agent[] = [
  {
    id: "ag_huzi",
    workspace_id: "ws_preview",
    runtime_id: previewRuntime.id,
    name: "户子",
    description: "MacBook / local execution",
    instructions: "",
    runtime_mode: "local",
    runtime_config: {},
    status: "idle",
    max_concurrent_tasks: 6,
    email_handle: "huzi",
    avatar_url: avatar("task", "dots", "dot", 1),
    visibility: "private",
    owner_id: null,
    created_at: now,
    updated_at: now,
  },
  {
    id: "ag_jesse",
    workspace_id: "ws_preview",
    runtime_id: previewRuntime.id,
    name: "杰西",
    description: "Implementation / technical check",
    instructions: "",
    runtime_mode: "local",
    runtime_config: {},
    status: "idle",
    max_concurrent_tasks: 6,
    email_handle: "jesse",
    avatar_url: avatar("book", "happy", "dash", 9),
    visibility: "private",
    owner_id: null,
    created_at: now,
    updated_at: now,
  },
  {
    id: "ag_mandy",
    workspace_id: "ws_preview",
    runtime_id: previewRuntime.id,
    name: "曼迪",
    description: "Coordination / acceptance",
    instructions: "",
    runtime_mode: "local",
    runtime_config: {},
    status: "idle",
    max_concurrent_tasks: 6,
    email_handle: "mandy",
    avatar_url: avatar("task", "dots", "dot", 5),
    visibility: "private",
    owner_id: null,
    created_at: now,
    updated_at: now,
  },
  {
    id: "ag_tony",
    workspace_id: "ws_preview",
    runtime_id: previewRuntime.id,
    name: "托尼",
    description: "Engineering execution",
    instructions: "",
    runtime_mode: "local",
    runtime_config: {},
    status: "idle",
    max_concurrent_tasks: 6,
    email_handle: "tony",
    avatar_url: avatar("book", "happy", "dash", 11),
    visibility: "private",
    owner_id: null,
    created_at: now,
    updated_at: now,
  },
  {
    id: "ag_fenge",
    workspace_id: "ws_preview",
    runtime_id: previewRuntime.id,
    name: "峰哥",
    description: "Email owner",
    instructions: "",
    runtime_mode: "local",
    runtime_config: {},
    status: "idle",
    max_concurrent_tasks: 6,
    email_handle: "fenge",
    avatar_url: avatar("mail", "dots", "smile", 3),
    visibility: "private",
    owner_id: null,
    created_at: now,
    updated_at: now,
  },
];

const taskCounts: Record<string, number> = {
  ag_mandy: 1,
  ag_fenge: 1,
};

const previewNodes: Node<AgentNodeData>[] = [
  { id: "ag_huzi", type: "agent", position: { x: 0, y: 0 }, data: { agent: previewAgents[0]!, runtimes: [previewRuntime], activeTaskCount: 0, slug: "preview", index: 0 } },
  { id: "ag_jesse", type: "agent", position: { x: 360, y: 0 }, data: { agent: previewAgents[1]!, runtimes: [previewRuntime], activeTaskCount: 0, slug: "preview", index: 1 } },
  { id: "ag_mandy", type: "agent", position: { x: 0, y: 220 }, data: { agent: previewAgents[2]!, runtimes: [previewRuntime], activeTaskCount: 1, slug: "preview", index: 2 } },
  { id: "ag_tony", type: "agent", position: { x: 360, y: 220 }, data: { agent: previewAgents[3]!, runtimes: [previewRuntime], activeTaskCount: 0, slug: "preview", index: 3 } },
  { id: "ag_fenge", type: "agent", position: { x: 720, y: 220 }, data: { agent: previewAgents[4]!, runtimes: [previewRuntime], activeTaskCount: 1, slug: "preview", index: 4 } },
];

const previewEdges: Edge[] = [
  {
    id: "edge-huzi-jesse",
    source: "ag_huzi",
    target: "ag_jesse",
    sourceHandle: "right",
    targetHandle: "target-left",
    type: "link",
    data: { instruction: "" },
  },
  {
    id: "edge-huzi-mandy",
    source: "ag_huzi",
    target: "ag_mandy",
    sourceHandle: "bottom",
    targetHandle: "target-top",
    type: "link",
    data: { instruction: "<p>preview</p>" },
  },
  {
    id: "edge-mandy-tony",
    source: "ag_mandy",
    target: "ag_tony",
    sourceHandle: "right",
    targetHandle: "target-left",
    type: "link",
    data: { instruction: "<p>preview</p>" },
  },
  {
    id: "edge-jesse-tony",
    source: "ag_jesse",
    target: "ag_tony",
    sourceHandle: "bottom",
    targetHandle: "target-top",
    type: "link",
    data: { instruction: "<p>preview</p>" },
  },
  {
    id: "edge-jesse-fenge",
    source: "ag_jesse",
    target: "ag_fenge",
    sourceHandle: "right",
    targetHandle: "target-top",
    type: "link",
    data: { instruction: "<p>preview</p>" },
  },
  {
    id: "edge-tony-fenge",
    source: "ag_tony",
    target: "ag_fenge",
    sourceHandle: "right",
    targetHandle: "target-left",
    type: "link",
    data: { instruction: "<p>preview</p>" },
  },
];

function PageSwitch({
  activePage,
  onPageChange,
}: {
  activePage: PreviewPage;
  onPageChange: (page: PreviewPage) => void;
}) {
  return (
    <div className="absolute left-4 top-4 z-50 inline-flex rounded-lg bg-background/80 p-1 ring-1 ring-foreground/5 shadow-sm backdrop-blur-sm">
      {[
        ["home", "Home Page"],
        ["other", "Other Page"],
      ].map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={activePage === id}
          onClick={() => onPageChange(id as PreviewPage)}
          className="h-7 min-w-22 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[active=true]:bg-accent data-[active=true]:text-foreground"
          data-active={activePage === id}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function PreviewSidebarAgent({ agent, isActive }: { agent: Agent; isActive?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const avatarConfig = parseAvatarUrl(agent.avatar_url);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={(event) => event.preventDefault()}
            className={cn(
              "relative flex shrink-0 items-center justify-center size-10 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer",
              isActive
                ? "ring-2 ring-primary shadow-sm"
                : "ring-0 bg-secondary text-secondary-foreground hover:bg-accent"
            )}
          />
        }
      >
        {avatarConfig ? (
          <AnimatedAvatar
            config={avatarConfig}
            size={40}
            className="rounded-xl"
            isHovered={hovered}
            isWorking={(taskCounts[agent.id] ?? 0) > 0}
          />
        ) : (
          agent.name.charAt(0).toUpperCase()
        )}
        <span className="absolute bottom-0 right-0 size-2 rounded-full bg-status-online ring-2 ring-background" />
      </TooltipTrigger>
      <TooltipContent side="right">{agent.name}</TooltipContent>
    </Tooltip>
  );
}

function PreviewSidebarButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              onClick?.();
            }}
            className={cn(
              "flex items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
              "text-muted-foreground hover:text-foreground hover:bg-accent",
              active && "bg-accent text-foreground"
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function PreviewSidebar({
  inboxCount,
  onInboxClick,
}: {
  inboxCount: number;
  onInboxClick: () => void;
}) {
  return (
    <nav className="flex h-full w-14 flex-col items-center gap-0.5 pt-1 pb-2">
      <div className="mb-1 pb-1.5">
        <div className="flex size-8 shrink-0 cursor-pointer items-center justify-center transition-transform active:scale-90 [&>button]:pointer-events-none">
          <Logo size="sm" iconOnly />
        </div>
      </div>

      <div className="mb-1 flex flex-col items-center gap-1.5 border-b border-border/50 pb-1.5">
        <PreviewSidebarButton label="Home" active>
          <Home className="size-4" />
        </PreviewSidebarButton>
        <PreviewSidebarButton label="Threads">
          <GitBranch className="size-4" />
        </PreviewSidebarButton>
        <PreviewSidebarButton label="Issues">
          <CircleDot className="size-4" />
        </PreviewSidebarButton>
        <PreviewSidebarButton label={`Inbox (${inboxCount})`} onClick={onInboxClick} active={inboxCount > 0}>
          <span className="relative grid size-4 place-items-center">
            <Inbox className="size-4" />
            {inboxCount > 0 ? (
              <span className="absolute -right-2 -top-2 grid min-w-3.5 place-items-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-3 text-primary-foreground">
                {Math.min(inboxCount, 9)}
              </span>
            ) : null}
          </span>
        </PreviewSidebarButton>
      </div>

      <div className="scrollbar-none flex w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto py-1">
        {previewAgents.map((agent, index) => (
          <PreviewSidebarAgent key={agent.id} agent={agent} isActive={index === 2} />
        ))}
        <button
          type="button"
          title="New agent"
          onClick={(event) => event.preventDefault()}
          className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-dashed border-foreground/15 text-muted-foreground transition-colors duration-200 hover:border-foreground/30 hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="mt-1 flex flex-col items-center gap-1 border-t border-border/50 pt-2">
        <PreviewSidebarButton label="Calendar">
          <CalendarDays className="size-4" />
        </PreviewSidebarButton>
        <PreviewSidebarButton label="Runtimes">
          <Monitor className="size-4" />
        </PreviewSidebarButton>
        <PreviewSidebarButton label="Toggle theme">
          <SunMoon className="size-4" />
        </PreviewSidebarButton>
        <PreviewSidebarButton label="Settings">
          <Settings className="size-4" />
        </PreviewSidebarButton>
        <PreviewSidebarButton label="Switch workspace">
          <ArrowLeftRight className="size-4" />
        </PreviewSidebarButton>
        <button
          type="button"
          aria-label="Preview user"
          onClick={(event) => event.preventDefault()}
          className="grid size-8 place-items-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground transition-colors hover:bg-accent"
        >
          T
        </button>
      </div>
    </nav>
  );
}

function PreviewToolbar() {
  const buttons = [
    ["Zoom in", ZoomIn],
    ["Zoom out", ZoomOut],
    ["Fit canvas", Maximize2],
    ["Reset layout", RotateCcw],
  ] as const;

  return (
    <div
      className="absolute bottom-4 left-4 z-40 flex animate-[fade-up_300ms_ease-out_both] gap-0.5 rounded-lg bg-background/80 p-1 ring-1 ring-foreground/5 backdrop-blur-sm"
      style={{ animationDelay: "200ms" }}
    >
      {buttons.map(([label, Icon]) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          onClick={(event) => event.preventDefault()}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}

function PreviewCreateButton() {
  return (
    <button
      type="button"
      title="Create new agent"
      onClick={(event) => event.preventDefault()}
      className="absolute top-4 right-4 z-40 flex size-8 animate-[fade-up_300ms_ease-out_both] items-center justify-center rounded-lg bg-background/80 text-muted-foreground ring-1 ring-foreground/5 backdrop-blur-sm transition-colors hover:bg-accent hover:text-foreground"
      style={{ animationDelay: "200ms" }}
    >
      <Plus className="size-4" />
    </button>
  );
}

function PreviewTasksFloat() {
  return (
    <div
      role="region"
      aria-label="Active tasks preview"
      className="absolute right-4 bottom-4 z-10 w-80 animate-[fade-up_300ms_ease-out_both] rounded-lg bg-background/90 shadow-sm ring-1 ring-foreground/8 backdrop-blur-sm"
    >
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="size-1.5 animate-pulse rounded-full bg-primary" />
          <span>2 tasks active</span>
        </div>
        <div className="flex items-center gap-0.5 text-muted-foreground">
          <button type="button" aria-label="Minimize tasks" className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground">
            <Minus className="size-3.5" />
          </button>
          <button type="button" aria-label="Close tasks panel" className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground">
            <span className="text-sm leading-none">×</span>
          </button>
        </div>
      </div>
      <div className="py-1">
        {[
          ["曼迪", "#alook_pet", "嗯，你再给我启动一下这个程序，我...", "just now", previewAgents[2]!],
          ["峰哥", "#default", "职位发布更新-错过跳过", "2m ago", previewAgents[4]!],
        ].map(([name, channel, prompt, time, agent]) => {
          const avatarConfig = parseAvatarUrl((agent as Agent).avatar_url);

          return (
            <div
              key={`${name}-${time}`}
              className="flex cursor-default items-center gap-2.5 rounded-md px-3 py-2 transition-colors hover:bg-accent/50"
            >
              <div className="relative shrink-0">
                {avatarConfig ? (
                  <AnimatedAvatar config={avatarConfig} size={24} className="rounded-full" isHovered={false} isWorking />
                ) : (
                  <span className="flex size-6 items-center justify-center rounded-full bg-secondary text-[7px] font-medium">
                    {String(name).charAt(0)}
                  </span>
                )}
                <span className="absolute -right-0.5 -bottom-0.5 size-2 animate-pulse rounded-full bg-primary ring-2 ring-background" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 leading-tight">
                  <span className="truncate text-sm font-medium">{String(name)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{String(channel)}</span>
                </div>
                <p className="truncate text-xs leading-tight text-muted-foreground">{String(prompt)}</p>
              </div>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{String(time)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PreviewHint() {
  return (
    <div className="absolute bottom-14 left-4 z-40 rounded-md bg-background/80 px-3 py-1.5 text-xs text-muted-foreground ring-1 ring-foreground/5 backdrop-blur-sm">
      Hover agents and relationship labels to preview the live home-page behavior.
    </div>
  );
}

function PreviewHomeCanvas({
  previewComebackToken,
  inboxNotificationToken,
}: {
  previewComebackToken: number;
  inboxNotificationToken: number;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodes = useMemo(() => previewNodes, []);
  const edges = useMemo(() => previewEdges, []);

  return (
    <div ref={canvasRef} className="relative isolate flex-1">
      <ReactFlow
        className="pet-preview-flow"
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.42, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={2.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        panOnScroll={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="var(--color-border)" />
      </ReactFlow>

      <CloudCodeMonsterPet
        boundaryRef={canvasRef}
        initialPosition={previewPetInitialPosition}
        previewComebackToken={previewComebackToken}
        notificationToken={inboxNotificationToken}
      />
      <PreviewToolbar />
      <PreviewHint />
      <PreviewTasksFloat />
      <PreviewCreateButton />
    </div>
  );
}

function OtherPage() {
  const [selectedPresetId, setSelectedPresetId] = useState(
    CLOUD_CODE_MONSTER_PET_PRESETS[0]!.id
  );
  const selectedPreset = getCloudCodeMonsterPreset(selectedPresetId);

  useEffect(() => {
    const syncPreset = (nextPresetId?: string | null) => {
      setSelectedPresetId(
        nextPresetId
          ? getCloudCodeMonsterPreset(nextPresetId).id
          : readCloudCodeMonsterPetPresetId()
      );
    };
    const handlePresetChange = (event: Event) => {
      syncPreset(
        (event as CustomEvent<{ presetId?: string }>).detail?.presetId
      );
    };

    syncPreset();
    window.addEventListener(
      CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
      handlePresetChange
    );

    return () => {
      window.removeEventListener(
        CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
        handlePresetChange
      );
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 px-4 pb-4 pt-14">
      <div className="grid min-h-0 w-full grid-cols-[minmax(210px,280px)_1fr] gap-4 max-lg:grid-cols-1">
        <section className="flex min-h-0 flex-col justify-between rounded-lg border border-border/60 bg-background/70 p-4 shadow-sm">
          <div>
            <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
              Other Page
            </div>
            <h1 className="mt-3 text-xl font-semibold tracking-normal">
              PET Presets
            </h1>
            <div className="mt-1 text-sm text-muted-foreground">
              {CLOUD_CODE_MONSTER_PET_PRESETS.length} presets
            </div>
          </div>

          <div className="mt-8 grid place-items-center rounded-lg bg-card/80 px-4 py-5 ring-1 ring-border/50">
            <CloudCodeMonsterPresetPreview
              preset={selectedPreset}
              className="size-32"
            />
            <div className="mt-3 text-center">
              <div className="text-sm font-medium">{selectedPreset.name}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {selectedPreset.id.replace("pet-", "#")}
              </div>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
            <div className="rounded-md bg-muted/60 px-2.5 py-2">
              <div className="font-medium text-foreground">Stored</div>
              <div className="mt-0.5">local preview</div>
            </div>
            <div className="rounded-md bg-muted/60 px-2.5 py-2">
              <div className="font-medium text-foreground">Home PET</div>
              <div className="mt-0.5">synced</div>
            </div>
          </div>
        </section>

        <section className="flex min-h-0 flex-col rounded-lg border border-border/60 bg-background/70 shadow-sm">
          <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
            <div className="text-sm font-medium">Preset Library</div>
            <div className="text-xs text-muted-foreground">
              {selectedPreset.id}
            </div>
          </div>
          <div className="thin-scrollbar grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {CLOUD_CODE_MONSTER_PET_PRESETS.map((preset) => {
              const isSelected = preset.id === selectedPreset.id;

              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    const nextPresetId = writeCloudCodeMonsterPetPresetId(
                      preset.id
                    );
                    setSelectedPresetId(nextPresetId);
                  }}
                  className={cn(
                    "group grid h-36 min-w-0 grid-rows-[1fr_auto] rounded-lg border bg-card/70 p-2.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:bg-accent/55 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
                    isSelected
                      ? "border-primary/50 bg-accent text-foreground shadow-sm"
                      : "border-border/50 text-muted-foreground"
                  )}
                >
                  <div className="grid place-items-center rounded-md bg-background/65 ring-1 ring-border/35">
                    <CloudCodeMonsterPresetPreview
                      preset={preset}
                      className="size-20 transition-transform duration-200 group-hover:scale-105"
                    />
                  </div>
                  <div className="mt-2 min-w-0">
                    <div className="truncate text-xs font-medium text-foreground">
                      {preset.name}
                    </div>
                    <div className="mt-0.5 text-[10px] leading-none text-muted-foreground">
                      {preset.id.replace("pet-", "#")}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

export function PetPreviewPage() {
  const [activePage, setActivePage] = useState<PreviewPage>("home");
  const [previewComebackToken, setPreviewComebackToken] = useState(0);
  const [inboxCount, setInboxCount] = useState(0);
  const [inboxNotificationToken, setInboxNotificationToken] = useState(0);
  const handlePageChange = (page: PreviewPage) => {
    if (page === "home" && activePage === "other") {
      setPreviewComebackToken((token) => token + 1);
    }

    setActivePage(page);
  };
  const handleInboxClick = () => {
    setInboxCount((count) => count + 1);
    setInboxNotificationToken((token) => token + 1);
  };

  return (
    <div className="relative flex h-dvh overflow-hidden">
      <GradientBackground />
      <PreviewSidebar inboxCount={inboxCount} onInboxClick={handleInboxClick} />
      <div className="flex min-w-0 flex-1 flex-col pt-1 pr-2 pb-2">
        <main className="relative flex min-h-0 flex-1 overflow-hidden rounded-xl bg-card/80 shadow-lg ring-1 ring-border/40 backdrop-blur-xl">
          <PageSwitch activePage={activePage} onPageChange={handlePageChange} />
          {activePage === "home" ? (
            <WorkspaceProvider workspaceId="ws_preview" slug="preview">
              <ReactFlowProvider>
                <PreviewHomeCanvas
                  previewComebackToken={previewComebackToken}
                  inboxNotificationToken={inboxNotificationToken}
                />
              </ReactFlowProvider>
            </WorkspaceProvider>
          ) : (
            <OtherPage />
          )}
        </main>
      </div>
    </div>
  );
}
