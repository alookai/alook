"use client"

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Activity,
  MoreVertical,
  MousePointer2,
  PlusCircle,
  RotateCcw,
  Smile,
} from "lucide-react"
import type { CommunityMachineSummary } from "@alook/shared"
import { AgentAvatar, type AvatarDraft } from "@/components/avatar"
import { ProviderLogo } from "@/components/provider-logo"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { AppSurface } from "@/components/ui/app-surface"
import { SheetBody, SheetFooter, SheetHeader } from "@/components/ui/sheet"
import { Shell } from "@/components/community/shell"
import { ServerRail } from "@/components/community/server-rail"
import { ChannelSidebar } from "@/components/community/channel-sidebar"
import { DmSidebar } from "@/components/community/dm-sidebar"
import { DmHeader } from "@/components/community/dm-header"
import { ChannelHeader } from "@/components/community/channel-header"
import { Message } from "@/components/community/message"
import { MachineCard } from "@/components/community/machines/machine-card"
import { PairMachineSteps } from "@/components/community/machines/pair-machine-sheet"
import { ConnectTile } from "@/components/community/onboarding-tiles/connect-tile"
import { BotFormFields } from "@/components/community/bots/bot-form-fields"
import { BotRuntimeFields } from "@/components/community/bots/bot-runtime-fields"
import { UserBar } from "@/components/community/user-bar"
import { useChannelTree } from "@/components/community/use-channel-tree"
import type { Category, DM, RenderMsg, Server } from "@/components/community/_types"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"
import { tid } from "@/lib/community/testids"
import {
  LANDING_MACHINE_RUNTIMES,
  SCENE_BEAT_DURATION_MS,
  SCENE_FINAL_HOLD_MS,
  SCENE_MAX_BEAT,
  galleryCameraTransform,
  sceneSnapshot,
  type LandingScene,
  type SceneSnapshot,
} from "./landing-shell-motion-timeline"
import styles from "./landing-shell-motion.module.css"

const SERVERS: Server[] = [
  { id: "gus", name: "Gus", initial: "G", active: true, mentions: 0, isOwner: true, icon: null },
]

const CHANNELS: Category[] = [
  {
    id: "cat_public",
    name: "Public",
    channels: [
      { id: "general", name: "general", active: true, unread: false, type: "text" },
    ],
  },
  {
    id: "cat_private",
    name: "Private",
    private: true,
    channels: [
      { id: "launch", name: "launch-room", active: false, unread: false, type: "text" },
    ],
  },
]

const DMS: DM[] = [
  { id: "dm-alli", userId: "alli", name: "Alli", discriminator: "8145", avatar: "avatar:beam:alli", status: "online", preview: "Available" },
]

const MESSAGES: RenderMsg[] = [
  {
    id: "m-gus",
    type: "chat",
    authorId: "gus",
    authorName: "Gus",
    authorAvatar: "avatar:beam:gus",
    content: "hello world",
    createdAt: "2026-08-06T04:20:00.000Z",
    seq: 425,
    grouped: false,
  },
  {
    id: "m-alli",
    type: "chat",
    authorId: "alli",
    authorName: "Alli",
    authorAvatar: "avatar:beam:alli",
    content: "On it.",
    createdAt: "2026-08-06T04:20:04.000Z",
    seq: 426,
    grouped: false,
  },
  {
    id: "m-ruth",
    type: "chat",
    authorId: "ruth",
    authorName: "Ruthann",
    authorAvatar: "avatar:beam:ruth",
    content: "I’ll review the flow.",
    createdAt: "2026-08-06T04:20:07.000Z",
    seq: 427,
    grouped: false,
  },
  {
    id: "m-shelly",
    type: "chat",
    authorId: "shelly",
    authorName: "Shelly",
    authorAvatar: "avatar:beam:shelly",
    content: "Ready to ship.",
    createdAt: "2026-08-06T04:20:11.000Z",
    seq: 428,
    grouped: false,
  },
]

const DM_MESSAGES: RenderMsg[] = [
  {
    id: "dm-message-gus",
    type: "chat",
    authorId: "gus",
    authorName: "Gus",
    authorAvatar: "avatar:beam:gus",
    content: "hello Alli",
    createdAt: "2026-08-06T04:21:00.000Z",
    seq: 429,
    grouped: false,
  },
  {
    id: "dm-message-alli",
    type: "chat",
    authorId: "alli",
    authorName: "Alli",
    authorAvatar: "avatar:beam:alli",
    content: "Hi Gus — I’m running on Codex.",
    createdAt: "2026-08-06T04:21:04.000Z",
    seq: 430,
    grouped: false,
  },
]

const ONLINE_MACHINE: CommunityMachineSummary = {
  id: "machine-studio",
  hostname: "gus-macbook",
  displayName: "Gus’s MacBook Pro",
  platform: "darwin",
  arch: "arm64",
  osRelease: "15.6",
  daemonVersion: "0.0.160",
  lastSeenAt: "2026-08-06T04:20:00.000Z",
  status: "online",
  availableRuntimes: [
    { id: LANDING_MACHINE_RUNTIMES[0], status: "healthy", version: "2.1.220 (Claude Code)" },
    { id: LANDING_MACHINE_RUNTIMES[1], status: "healthy", version: "codex-cli 0.146.0" },
    { id: LANDING_MACHINE_RUNTIMES[2], status: "healthy", version: "2026.08.04-aaa8809" },
    { id: LANDING_MACHINE_RUNTIMES[3], status: "healthy", version: "1.17.20" },
    { id: LANDING_MACHINE_RUNTIMES[4], status: "healthy", version: "0.80.3" },
  ],
  createdAt: "2026-08-06T04:20:00.000Z",
  updatedAt: "2026-08-06T04:20:00.000Z",
}

const RUNTIME_OPTIONS = ONLINE_MACHINE.availableRuntimes.map((runtime) => ({
  id: runtime.id,
  unhealthy: runtime.status !== "healthy",
}))

const BOT_AVATAR_DRAFT: AvatarDraft = {
  kind: "procedural",
  image: serializeBeamSeed("alli"),
}

const PAIR_COMMAND =
  "pnpm daemon start --machine-key cmk_demo --server-url https://alook.ai --ws-url wss://alook.ai/api/ws/community-daemon"

function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const sync = () => setReduced(query.matches)
    sync()
    query.addEventListener("change", sync)
    return () => query.removeEventListener("change", sync)
  }, [])
  return reduced
}

function useTargetCursor(
  cameraRef: RefObject<HTMLDivElement | null>,
  targetId: string | null,
  stageScale: number,
) {
  const [cursor, setCursor] = useState({
    x: 0,
    y: 0,
    visible: false,
    targetId: null as string | null,
  })

  useLayoutEffect(() => {
    const camera = cameraRef.current
    if (!camera || !targetId) {
      setCursor((current) =>
        current.visible || current.targetId
          ? { ...current, visible: false, targetId: null }
          : current,
      )
      return
    }

    setCursor((current) =>
      current.targetId === targetId
        ? current
        : { ...current, visible: false, targetId: null },
    )

    const sync = () => {
      const target = camera.querySelector<HTMLElement>(
        `[data-motion-target="${targetId}"]`,
      )
      if (!target) {
        setCursor((current) =>
          current.visible || current.targetId
            ? { ...current, visible: false, targetId: null }
            : current,
        )
        return
      }
      const cameraRect = camera.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const scale = cameraRect.width / camera.offsetWidth || stageScale || 1
      const anchorX = Number(target.dataset.motionAnchorX ?? "0.5")
      const anchorY = Number(target.dataset.motionAnchorY ?? "0.5")
      setCursor({
        x: (targetRect.left - cameraRect.left + targetRect.width * anchorX) / scale,
        y: (targetRect.top - cameraRect.top + targetRect.height * anchorY) / scale,
        visible: true,
        targetId,
      })
    }

    const firstFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(sync)
    })
    const observer = new ResizeObserver(sync)
    observer.observe(camera)
    camera.addEventListener("scroll", sync, true)
    return () => {
      window.cancelAnimationFrame(firstFrame)
      observer.disconnect()
      camera.removeEventListener("scroll", sync, true)
    }
  }, [cameraRef, stageScale, targetId])

  return cursor
}

function useVisualFocus(scene: LandingScene, focus: string | null) {
  const [visualFocus, setVisualFocus] = useState<string | null>(null)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setVisualFocus(focus))
    return () => window.cancelAnimationFrame(frame)
  }, [focus, scene])

  return visualFocus
}

export function LandingShellMotion({ scene }: { scene: LandingScene }) {
  const [beat, setBeat] = useState(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const cameraRef = useRef<HTMLDivElement>(null)
  const [stageScale, setStageScale] = useState(1)
  const reducedMotion = useReducedMotion()
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } }),
  )
  const maxBeat = SCENE_MAX_BEAT[scene]

  useEffect(() => {
    setBeat(reducedMotion ? maxBeat : 0)
  }, [scene, maxBeat, reducedMotion])

  useEffect(() => {
    if (reducedMotion) return
    const delay = beat >= maxBeat ? SCENE_FINAL_HOLD_MS : SCENE_BEAT_DURATION_MS
    const timer = window.setTimeout(() => {
      setBeat((current) => (current >= maxBeat ? 0 : current + 1))
    }, delay)
    return () => window.clearTimeout(timer)
  }, [beat, maxBeat, reducedMotion])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const sync = () => setStageScale(stage.getBoundingClientRect().width / 1120)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  const snapshot = sceneSnapshot(scene, beat)
  const visualFocus = useVisualFocus(scene, snapshot.focus)
  const visualSnapshot = { ...snapshot, focus: visualFocus }
  const cursor = useTargetCursor(cameraRef, visualFocus, stageScale)
  const cameraReady = Boolean(
    snapshot.focus &&
    visualFocus === snapshot.focus &&
    cursor.visible &&
    cursor.targetId === snapshot.focus,
  )
  const camera = galleryCameraTransform(
    snapshot.camera,
    cameraReady ? cursor : null,
  )

  return (
    <div className={styles.root}>
      <div
        ref={stageRef}
        className={styles.stage}
        data-testid="landing-motion-stage"
        data-scene={scene}
        data-beat={snapshot.beat}
        aria-hidden
      >
        <div
          className={styles.canvas}
          style={{ "--stage-scale": stageScale } as CSSProperties}
        >
          <div
            ref={cameraRef}
            className={styles.camera}
            data-camera-scale={camera.scale}
            style={
              {
                "--camera-scale": camera.scale,
                "--camera-origin-x": `${camera.x}px`,
                "--camera-origin-y": `${camera.y}px`,
              } as CSSProperties
            }
          >
            <QueryClientProvider client={queryClient}>
              <PrototypeShell scene={scene} snapshot={visualSnapshot} />
            </QueryClientProvider>
            <MousePointer2
              aria-hidden
              data-testid="landing-motion-cursor"
              className={styles.cursor}
              data-cursor-target={visualFocus ?? undefined}
              style={{ left: cursor.x, top: cursor.y, opacity: cameraReady ? 1 : 0 }}
              fill="var(--background)"
              strokeWidth={1.8}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function PrototypeShell({ scene, snapshot }: { scene: LandingScene; snapshot: SceneSnapshot }) {
  const serverView = scene === "server"
  return (
    <Shell>
      <ServerRail
        servers={SERVERS}
        folders={[]}
        activeServerId="gus"
        view={serverView ? "server" : "dm"}
        bottomInset={60}
        onHome={() => {}}
        onServer={() => {}}
        onServerNavigate={() => {}}
      />
      <div className="relative flex min-w-0 flex-1 flex-col pt-2">
        <AppSurface className="rounded-tl-xl rounded-tr-none rounded-br-none rounded-bl-none border-l border-t border-border/40 shadow-none ring-0">
          <div className="flex min-h-0 flex-1">
            <div
              key={`sidebar-${scene}`}
              className={`flex w-60 shrink-0 flex-col bg-sidebar pb-14 ${styles.sceneEnter}`}
            >
              {serverView ? (
                <PrototypeChannelSidebar />
              ) : (
                <PrototypeDmSidebar scene={scene} snapshot={snapshot} />
              )}
            </div>
            <div
              key={`content-${scene}`}
              className={`flex min-w-0 flex-1 flex-col bg-background ${styles.sceneEnter}`}
            >
              {scene === "server" && <ServerScene snapshot={snapshot} />}
              {scene === "machine" && <MachineScene snapshot={snapshot} />}
              {scene === "provider" && <ProviderScene snapshot={snapshot} />}
            </div>
          </div>
        </AppSurface>
        <div className="absolute bottom-0 left-0 z-10 -ml-14 w-74">
          <UserBar
            user={{ id: "gus", name: "Gus", avatar: "avatar:beam:gus" }}
            onEditProfile={() => {}}
          />
        </div>
      </div>
    </Shell>
  )
}

function PrototypeChannelSidebar() {
  const tree = useChannelTree(CHANNELS)
  return (
    <ChannelSidebar
      tree={tree}
      serverName="Gus"
      activeChannel="general"
      setActiveChannel={() => {}}
      isAdmin={false}
      currentUserId="gus"
    />
  )
}

function PrototypeDmSidebar({
  scene,
  snapshot,
}: {
  scene: LandingScene
  snapshot: SceneSnapshot
}) {
  const sidebarRef = useRef<HTMLDivElement>(null)
  const dmOpen = scene === "provider" && snapshot.beat >= 6

  useLayoutEffect(() => {
    const row = sidebarRef.current?.querySelector<HTMLElement>(
      `[data-testid="${tid.dmRow("dm-alli")}"]`,
    )
    row?.setAttribute("data-motion-target", "dm-alli")
    return () => {
      row?.removeAttribute("data-motion-target")
    }
  }, [])

  return (
    <div ref={sidebarRef} className="flex min-h-0 flex-1 flex-col">
      <DmSidebar
        dms={DMS}
        activeDm={dmOpen ? "dm-alli" : null}
        onPickDm={() => {}}
        onShowFriends={() => {}}
        onShowMachines={() => {}}
        onShowBots={() => {}}
        machinesActive={scene === "machine"}
        botsActive={scene === "provider" && !dmOpen}
      />
    </div>
  )
}

function targetClass(snapshot: SceneSnapshot, id: string, className?: string) {
  return [
    styles.motionTarget,
    snapshot.focus === id ? styles.focus : snapshot.focus ? styles.recede : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ")
}

function PrototypeSheet({
  children,
  label,
  open = true,
}: {
  children: ReactNode
  label: string
  open?: boolean
}) {
  return (
    <aside
      aria-label={label}
      aria-hidden={!open}
      data-slot="sheet-content"
      data-open={open}
      className={styles.sheetSurface}
    >
      {children}
    </aside>
  )
}

function ServerScene({ snapshot }: { snapshot: SceneSnapshot }) {
  return (
    <>
      <ChannelHeader
        channel="general"
        rightPanel={null}
        onToggle={() => {}}
        server={{ id: "gus", name: "Gus", icon: null }}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden px-4 py-3">
          {MESSAGES.map((message, index) => (
            <div
              key={message.id}
              data-visible={index < snapshot.visibleMessages}
              className={styles.messageSlot}
            >
              <div
                data-motion-target={`message-${message.authorId}`}
                className={targetClass(snapshot, `message-${message.authorId}`)}
              >
                <Message m={message} onOpenThread={() => {}} />
              </div>
            </div>
          ))}
        </div>
        <PrototypeComposer
          snapshot={snapshot}
          target="composer"
          placeholder="Message /general"
        />
      </div>
    </>
  )
}

function PrototypeComposer({
  snapshot,
  target,
  placeholder,
}: {
  snapshot: SceneSnapshot
  target: string
  placeholder: string
}) {
  return (
    <div className="relative px-3 pb-3 pt-0">
      <div
        className={targetClass(
          snapshot,
          target,
          "relative rounded-xl bg-muted shadow-(--e1) ring-1 ring-border/40 transition-shadow",
        )}
      >
        <div
          data-motion-target={target}
          data-motion-anchor-x="0.24"
          className="relative px-12 py-3 text-base leading-6"
        >
          <span
            data-visible={!snapshot.composerText}
            className={`${styles.composerLayer} text-muted-foreground`}
          >
            {placeholder}
          </span>
          <span
            data-visible={Boolean(snapshot.composerText)}
            className={styles.composerLayer}
          >
            {snapshot.composerText && (
              <span className={styles.typingText}>{snapshot.composerText}</span>
            )}
            <span className="ml-0.5 inline-block h-5 w-px bg-foreground align-middle" />
          </span>
        </div>
        <button
          className="absolute bottom-2 left-2 grid size-8 place-items-center rounded-full text-muted-foreground"
          aria-label="Add"
        >
          <PlusCircle className="size-5" />
        </button>
        <button
          className="absolute right-2 bottom-2 grid size-8 place-items-center rounded-full text-muted-foreground"
          aria-label="Emoji picker"
        >
          <Smile className="size-5" />
        </button>
      </div>
    </div>
  )
}

function MachineScene({ snapshot }: { snapshot: SceneSnapshot }) {
  const online = snapshot.machineState === "online" || snapshot.machineState === "bot-born"
  const pairOpen = snapshot.pairSheet !== "closed"
  const pairConnected = snapshot.pairSheet === "connected"
  const step2Target = pairConnected ? "pair-connected" : "pair-step-2"
  return (
    <>
      <div className={`${styles.stateStack} min-h-0 flex-1`}>
        <div
          data-visible={!online}
          className={`${styles.stateLayer} flex min-w-0 flex-col`}
        >
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-12 text-center">
            <div className="w-full max-w-70 overflow-hidden rounded-xl">
              <div className="aspect-200/130 w-full">
                <ConnectTile idPrefix="landing-motion-connect" />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-medium text-foreground">No machines yet</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Connect a machine and your bots run on it always-on — reach them from
                your phone or anywhere, wherever you sign in.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                data-onboarding-target="connect-machine"
                data-motion-target="connect"
                className={targetClass(snapshot, "connect")}
              >
                Connect a machine
              </Button>
              <Button variant="ghost">Guide me</Button>
            </div>
          </div>
        </div>

        <div
          data-visible={online}
          className={`${styles.stateLayer} flex min-w-0 flex-col gap-6 overflow-hidden p-6`}
        >
          <header className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-medium text-foreground">Machines</h1>
              <p className="text-sm text-muted-foreground">
                Your computers running the alook daemon.
              </p>
            </div>
            <Button>Connect a machine</Button>
          </header>

          <div
            data-motion-target="machine"
            className={targetClass(snapshot, "machine")}
          >
            <MachineCard machine={ONLINE_MACHINE} onDelete={() => {}} onReconnect={() => {}} />
          </div>

          <div
            data-visible={snapshot.machineState === "bot-born"}
            className={styles.resultReveal}
          >
            <div
              data-motion-target="born-bot"
              className={targetClass(snapshot, "born-bot")}
            >
              <BotCard runtime="claude" model={null} status="Born on Gus’s MacBook Pro" />
            </div>
          </div>
        </div>
      </div>

      <PrototypeSheet label="Connect a machine" open={pairOpen}>
        <SheetHeader>
          <h2 className="font-heading text-lg leading-tight font-semibold">Connect a machine</h2>
        </SheetHeader>
          <SheetBody className="flex flex-col gap-6">
            <PairMachineSteps
              command={PAIR_COMMAND}
              generating={false}
              onCopy={() => {}}
              connectedHostname={pairConnected ? ONLINE_MACHINE.displayName : null}
              step1MotionTarget="pair-step-1"
              step2MotionTarget={step2Target}
              step1ClassName={targetClass(snapshot, "pair-step-1")}
              step2ClassName={targetClass(snapshot, step2Target)}
            />
          </SheetBody>
          <SheetFooter>
            <Button variant="secondary">Done</Button>
          </SheetFooter>
      </PrototypeSheet>
    </>
  )
}

function ProviderScene({ snapshot }: { snapshot: SceneSnapshot }) {
  const sheetBodyRef = useRef<HTMLDivElement>(null)
  const dmOpen = snapshot.beat >= 6
  const sheetOpen = snapshot.beat >= 3 && snapshot.beat < 5
  const botMenuOpen = snapshot.beat === 2

  useEffect(() => {
    const body = sheetBodyRef.current
    if (!body) return
    if (snapshot.beat === 0) {
      body.scrollTo({ top: 0 })
      return
    }
    if (snapshot.beat !== 3) return
    const targetId = "runtime-codex"
    const frame = window.requestAnimationFrame(() => {
      const target = body.querySelector<HTMLElement>(
        `[data-motion-target="${targetId}"]`,
      )
      if (!target) return
      const bodyRect = body.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      body.scrollTo({
        top:
          body.scrollTop +
          targetRect.top -
          bodyRect.top -
          (body.clientHeight - targetRect.height) / 2,
        behavior: "smooth",
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [snapshot.beat])

  return (
    <>
      <div className={`${styles.stateStack} min-h-0 flex-1`}>
        <div
          data-visible={!dmOpen}
          className={`${styles.stateLayer} flex min-w-0 flex-col gap-6 overflow-hidden p-6`}
        >
          <header>
            <h1 className="text-xl font-medium text-foreground">My Bots</h1>
          </header>
          <div className="max-w-lg">
            <BotCard
              runtime={snapshot.runtime}
              model={snapshot.model}
              status="Online"
              snapshot={snapshot}
              menuOpen={botMenuOpen}
            />
          </div>
        </div>
        <div
          data-visible={dmOpen}
          className={`${styles.stateLayer} flex min-w-0 flex-col overflow-hidden`}
        >
          <DmHeader dm={DMS[0]} />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex-1 overflow-hidden px-4 py-3">
              {DM_MESSAGES.map((message, index) => (
                <div
                  key={message.id}
                  data-visible={index < snapshot.visibleMessages}
                  className={styles.messageSlot}
                >
                  <div
                    data-motion-target={`dm-message-${message.authorId}`}
                    className={targetClass(snapshot, `dm-message-${message.authorId}`)}
                  >
                    <Message m={message} onOpenThread={() => {}} />
                  </div>
                </div>
              ))}
            </div>
            <PrototypeComposer
              snapshot={snapshot}
              target="dm-composer"
              placeholder="Message @Alli"
            />
          </div>
        </div>
      </div>

      <PrototypeSheet label="Edit Alli" open={sheetOpen}>
        <SheetHeader>
          <h2 className="font-heading text-lg leading-tight font-semibold">Edit Alli</h2>
        </SheetHeader>
        <SheetBody ref={sheetBodyRef} className="flex flex-col gap-6">
          <BotFormFields
            avatarDraft={BOT_AVATAR_DRAFT}
            onAvatarChange={() => {}}
            name="Alli"
            setName={() => {}}
            onShuffle={() => {}}
            description=""
            setDescription={() => {}}
          />
          <div>
            <BotRuntimeFields
              options={RUNTIME_OPTIONS}
              runtime={snapshot.runtime}
              model={snapshot.model}
              onRuntimeChange={() => {}}
              onModelChange={() => {}}
              radioName="landing-motion-runtime"
              motionTargetPrefix="runtime"
              modelMotionTarget="model"
              runtimeOptionClassName={(runtime) =>
                targetClass(snapshot, `runtime-${runtime}`)
              }
              modelClassName={targetClass(snapshot, "model")}
            />
          </div>
        </SheetBody>
        <SheetFooter>
          <Button variant="outline">Cancel</Button>
          <Button
            data-motion-target="save-provider"
            className={targetClass(snapshot, "save-provider")}
          >
            Save
          </Button>
        </SheetFooter>
      </PrototypeSheet>
    </>
  )
}

function BotCard({
  runtime,
  model,
  status,
  snapshot,
  menuOpen = false,
}: {
  runtime: string
  model: string | null
  status: string
  snapshot?: SceneSnapshot
  menuOpen?: boolean
}) {
  const actionButtonClass =
    "grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
  const menuItemClass =
    "flex items-center gap-2 rounded-md px-2 py-2 text-sm text-popover-foreground"
  return (
    <div className="relative">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <AgentAvatar name="Alli" seed="alli" size={40} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-medium text-foreground">Alli</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                <span className="size-1.5 rounded-full bg-status-online" />
                {status}
              </span>
            </div>
            <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <ProviderLogo provider={runtime} className="size-3.5" />
                <span>{runtime}</span>
              </span>
              <span aria-hidden>·</span>
              <span className="font-mono">{model ?? "local default"}</span>
            </span>
          </div>
          <button
            aria-label="Bot actions"
            data-motion-target={snapshot ? "bot-actions" : undefined}
            className={
              snapshot
                ? targetClass(snapshot, "bot-actions", actionButtonClass)
                : actionButtonClass
            }
          >
            <MoreVertical className="size-4" />
          </button>
        </div>
      </Card>
      {snapshot && (
        <div data-visible={menuOpen} className={styles.botMenu}>
          <div className={menuItemClass}>
            <span className="size-4" aria-hidden /> Chat
          </div>
          <div className={menuItemClass}>
            <Activity className="size-4" /> View activity
          </div>
          <div
            data-motion-target="bot-edit"
            className={targetClass(snapshot, "bot-edit", menuItemClass)}
          >
            <span className="size-4" aria-hidden /> Edit
          </div>
          <div className={menuItemClass}>
            <RotateCcw className="size-4" /> Reset
          </div>
          <div className={`${menuItemClass} text-destructive`}>
            <span className="size-4" aria-hidden /> Delete
          </div>
        </div>
      )}
    </div>
  )
}
