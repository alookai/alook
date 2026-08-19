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
  Check,
  MoreVertical,
  MousePointer2,
  PlusCircle,
  RotateCcw,
  Search,
  Smile,
  UserPlus,
} from "lucide-react"
import type { CommunityMachineSummary } from "@alook/shared"
import { AgentAvatar, type AvatarDraft } from "@/components/avatar"
import { ProviderLogo } from "@/components/provider-logo"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { AppSurface } from "@/components/ui/app-surface"
import { SheetBody, SheetFooter, SheetHeader } from "@/components/ui/sheet"
import { Shell } from "@/components/community/shell/shell"
import { ServerRail } from "@/components/community/shell/server-rail"
import { ChannelSidebar } from "@/components/community/channels/channel-sidebar"
import { DmSidebar } from "@/components/community/channels/dm-sidebar"
import { DmHeader } from "@/components/community/channels/dm-header"
import { ChannelHeader } from "@/components/community/channels/channel-header"
import { Avatar } from "@/components/community/avatar"
import { Message } from "@/components/community/messages/message"
import { TypingIndicator } from "@/components/community/messages/typing-indicator"
import { InboxPopover } from "@/components/community/shell/community-inbox-popover"
import { MachineCard } from "@/components/community/machines/machine-card"
import { PairMachineSteps } from "@/components/community/machines/pair-machine-sheet"
import { ConnectTile } from "@/components/community/onboarding-tiles/connect-tile"
import { BotFormFields } from "@/components/community/bots/bot-form-fields"
import { BotRuntimeFields } from "@/components/community/bots/bot-runtime-fields"
import { UserBar } from "@/components/community/shell/user-bar"
import { useChannelTree } from "@/components/community/channels/use-channel-tree"
import type { Category, Server } from "@/lib/community/models/navigation"
import type { DM } from "@/lib/community/models/people"
import type { RenderMsg } from "@/lib/community/models/message"
import type { UnreadServer } from "@/lib/community/models/inbox"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"
import { tid } from "@/lib/community/testids"
import {
  LANDING_MACHINE_RUNTIMES,
  LANDING_IDENTITY_MAYA,
  SCENE_BEAT_DURATION_MS,
  SCENE_FINAL_HOLD_MS,
  SCENE_MAX_BEAT,
  galleryCameraTransform,
  sceneSnapshot,
  type LandingScene,
  type LandingRoom,
  type SceneSnapshot,
} from "./landing-shell-motion-timeline"
import styles from "./landing-shell-motion.module.css"
import { useLandingMotionPlayback } from "./use-landing-motion-playback"

const SERVERS: Server[] = [
  { id: "gus", name: "Gus", initial: "G", active: true, mentions: 0, isOwner: true, icon: null },
]

const SPACE_SERVERS: Server[] = [
  { id: "work", name: "Studio", initial: "S", active: true, mentions: 0, isOwner: true, icon: null },
  { id: "life", name: "Home", initial: "H", active: false, mentions: 0, isOwner: true, icon: null },
  { id: "play", name: "Game Night", initial: "G", active: false, mentions: 0, isOwner: true, icon: null },
]

const OVERVIEW_SERVERS: Server[] = [
  ...SERVERS,
  ...SPACE_SERVERS.map((server) => ({ ...server, active: false })),
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

const SPACE_CHANNELS: Record<LandingRoom, Category[]> = {
  work: [
    {
      id: "cat_work_public",
      name: "Public",
      channels: [
        { id: "work-general", name: "general", active: true, unread: false, type: "text" },
        { id: "work-design", name: "design-review", active: false, unread: false, type: "text" },
      ],
    },
    {
      id: "cat_work_private",
      name: "Private",
      private: true,
      channels: [
        { id: "work-launch", name: "launch-room", active: false, unread: false, type: "text" },
        { id: "work-release", name: "release-notes", active: false, unread: false, type: "text" },
      ],
    },
  ],
  life: [
    {
      id: "cat_life_public",
      name: "Public",
      channels: [
        { id: "life-kitchen", name: "kitchen", active: true, unread: false, type: "text" },
        { id: "life-photos", name: "photos", active: false, unread: false, type: "text" },
      ],
    },
    {
      id: "cat_life_private",
      name: "Private",
      private: true,
      channels: [
        { id: "life-plans", name: "family-plans", active: false, unread: false, type: "text" },
        { id: "life-travel", name: "travel", active: false, unread: false, type: "text" },
      ],
    },
  ],
  play: [
    {
      id: "cat_play_public",
      name: "Public",
      channels: [
        { id: "play-lobby", name: "lobby", active: true, unread: false, type: "text" },
        { id: "play-clips", name: "clips", active: false, unread: false, type: "text" },
      ],
    },
    {
      id: "cat_play_private",
      name: "Private",
      private: true,
      channels: [
        { id: "play-party", name: "party-chat", active: false, unread: false, type: "text" },
        { id: "play-strategy", name: "strategy", active: false, unread: false, type: "text" },
      ],
    },
  ],
}

const CONTINUITY_CHANNELS: Record<LandingRoom, Category[]> = {
  work: [
    {
      id: "cat_continuity_work",
      name: "Public",
      channels: [
        { id: "continuity-frontend-design", name: "frontend-design", active: true, unread: false, type: "text" },
        { id: "continuity-launch", name: "launch", active: false, unread: false, type: "text" },
      ],
    },
  ],
  life: [
    {
      id: "cat_continuity_life",
      name: "Private",
      private: true,
      channels: [
        { id: "continuity-family", name: "family", active: true, unread: false, type: "text" },
        { id: "continuity-travel", name: "travel", active: false, unread: false, type: "text" },
      ],
    },
  ],
  play: SPACE_CHANNELS.play,
}

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
    createdAt: "2026-08-06T04:21:00.000Z",
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
    createdAt: "2026-08-06T04:22:00.000Z",
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
    createdAt: "2026-08-06T04:23:00.000Z",
    seq: 428,
    grouped: false,
  },
]

const SPACE_MESSAGES: Record<LandingRoom, RenderMsg[]> = {
  work: [
    {
      id: "space-work-gus",
      type: "chat",
      authorId: "gus",
      authorName: "Gus",
      authorAvatar: "avatar:beam:gus",
      content: "The new gallery story is ready.",
      createdAt: "2026-08-06T06:00:00.000Z",
      seq: 501,
      grouped: false,
    },
    {
      id: "space-work-shelly",
      type: "chat",
      authorId: "shelly",
      authorName: "Shelly",
      authorAvatar: "avatar:beam:shelly",
      content: "I’ll ship it after review.",
      createdAt: "2026-08-06T06:00:05.000Z",
      seq: 502,
      grouped: false,
    },
  ],
  life: [
    {
      id: "space-life-gus",
      type: "chat",
      authorId: "gus-life",
      authorName: "Gus",
      authorAvatar: "avatar:beam:gus",
      content: "Dinner at seven?",
      createdAt: "2026-08-06T06:01:00.000Z",
      seq: 503,
      grouped: false,
    },
    {
      id: "space-life-alli",
      type: "chat",
      authorId: "alli-life",
      authorName: "Alli",
      authorAvatar: "avatar:beam:alli",
      content: "I’ll remind everyone.",
      createdAt: "2026-08-06T06:01:04.000Z",
      seq: 504,
      grouped: false,
    },
    {
      id: "space-life-maya",
      type: "chat",
      authorId: "maya",
      authorName: "Maya",
      authorAvatar: "avatar:beam:maya",
      content: "I’m in — I’ll bring dessert.",
      createdAt: "2026-08-06T06:01:08.000Z",
      seq: 505,
      grouped: false,
    },
  ],
  play: [
    {
      id: "space-play-noah",
      type: "chat",
      authorId: "noah",
      authorName: "Noah",
      authorAvatar: "avatar:beam:noah",
      content: "Game night at eight.",
      createdAt: "2026-08-06T06:02:00.000Z",
      seq: 506,
      grouped: false,
    },
    {
      id: "space-play-quest",
      type: "chat",
      authorId: "quest",
      authorName: "Quest Bot",
      authorAvatar: "avatar:beam:quest",
      content: "The room and teams are ready.",
      createdAt: "2026-08-06T06:02:04.000Z",
      seq: 507,
      grouped: false,
    },
    {
      id: "space-play-gus",
      type: "chat",
      authorId: "gus-play",
      authorName: "Gus",
      authorAvatar: "avatar:beam:gus",
      content: "Let’s go.",
      createdAt: "2026-08-06T06:02:08.000Z",
      seq: 508,
      grouped: false,
    },
  ],
}

const IDENTITY_MESSAGES: Record<LandingRoom, RenderMsg[]> = Object.fromEntries(
  (["work", "life", "play"] as const).map((room, index) => [
    room,
    [{
      id: `identity-${room}-maya`,
      type: "chat" as const,
      ...LANDING_IDENTITY_MAYA,
      createdAt: `2026-08-06T06:0${index}:08.000Z`,
      seq: 520 + index,
      grouped: false,
    }],
  ]),
) as Record<LandingRoom, RenderMsg[]>

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

const CONTINUITY_DM_MESSAGES: RenderMsg[] = [
  {
    id: "continuity-dm-gus",
    type: "chat",
    authorId: "gus",
    authorName: "Gus",
    authorAvatar: "avatar:beam:gus",
    content: "Alli, please move today’s priorities forward.",
    createdAt: "2026-08-07T08:30:00.000Z",
    seq: 610,
    grouped: false,
  },
  {
    id: "continuity-dm-alli",
    type: "chat",
    authorId: "alli",
    authorName: "Alli",
    authorAvatar: "avatar:beam:alli",
    content: "Got it. I’ll ask Shelly for today’s A/B conversion update, then check with Tracy about the home router.",
    createdAt: "2026-08-07T08:30:04.000Z",
    seq: 611,
    grouped: false,
  },
]

const CONTINUITY_WORK_MESSAGES: RenderMsg[] = [
  {
    id: "continuity-work-alli",
    type: "chat",
    authorId: "alli",
    authorName: "Alli",
    authorAvatar: "avatar:beam:alli",
    content: "@Shelly#3863 How are Gus’s A/B landing pages converting today?",
    createdAt: "2026-08-07T08:31:00.000Z",
    seq: 612,
    grouped: false,
  },
  {
    id: "continuity-work-shelly",
    type: "chat",
    authorId: "shelly",
    authorName: "Shelly",
    authorAvatar: "avatar:beam:shelly",
    content: "B is ahead on sign-ups. I’m checking the mobile drop-off.",
    createdAt: "2026-08-07T08:31:05.000Z",
    seq: 613,
    grouped: false,
  },
]

const CONTINUITY_LIFE_MESSAGES: RenderMsg[] = [
  {
    id: "continuity-life-alli",
    type: "chat",
    authorId: "alli",
    authorName: "Alli",
    authorAvatar: "avatar:beam:alli",
    content: "@Tracy#2048 Is the router at home still dropping out?",
    createdAt: "2026-08-07T08:32:00.000Z",
    seq: 614,
    grouped: false,
  },
  {
    id: "continuity-life-tracy",
    type: "chat",
    authorId: "tracy",
    authorName: "Tracy",
    authorAvatar: "avatar:beam:tracy",
    content: "Yes — it dropped twice this morning.",
    createdAt: "2026-08-07T08:32:05.000Z",
    seq: 615,
    grouped: false,
  },
]

const CONTINUITY_WORK_UNREAD: UnreadServer[] = [
  {
    serverId: "work",
    serverName: "Studio",
    channels: [
      {
        channelId: "continuity-frontend-design",
        channelName: "frontend-design",
        type: "text",
        lastMessageAt: "2026-08-07T08:31:05.000Z",
        mentionCount: 0,
        children: [],
      },
    ],
  },
]

const CONTINUITY_LIFE_UNREAD: UnreadServer[] = [
  {
    serverId: "life",
    serverName: "Home",
    channels: [
      {
        channelId: "continuity-family",
        channelName: "family",
        type: "text",
        lastMessageAt: "2026-08-07T08:32:05.000Z",
        mentionCount: 0,
        children: [],
      },
    ],
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
  "npx --yes @alook/daemon@latest daemon start --machine-key cmk_demo"

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

export function LandingShellMotion({
  scene,
  machineIntroDescription,
  overviewDetails = false,
  beat: controlledBeat,
}: {
  scene: LandingScene
  machineIntroDescription?: string
  overviewDetails?: boolean
  beat?: number
}) {
  const [localBeat, setLocalBeat] = useState(0)
  const {
    targetRef: playbackRef,
    isPlaying,
    shouldReset,
  } = useLandingMotionPlayback<HTMLDivElement>()
  const stageRef = useRef<HTMLDivElement>(null)
  const cameraRef = useRef<HTMLDivElement>(null)
  const [stageScale, setStageScale] = useState(1)
  const reducedMotion = useReducedMotion()
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } }),
  )
  const maxBeat = SCENE_MAX_BEAT[scene]
  const beat = controlledBeat ?? localBeat

  useEffect(() => {
    if (controlledBeat === undefined) {
      setLocalBeat(reducedMotion ? maxBeat : 0)
    }
  }, [controlledBeat, scene, maxBeat, reducedMotion])

  useEffect(() => {
    if (controlledBeat === undefined && !reducedMotion && shouldReset) {
      setLocalBeat(0)
    }
  }, [controlledBeat, reducedMotion, shouldReset])

  useEffect(() => {
    if (controlledBeat !== undefined || reducedMotion || !isPlaying) return
    const delay = beat >= maxBeat ? SCENE_FINAL_HOLD_MS : SCENE_BEAT_DURATION_MS
    const timer = window.setTimeout(() => {
      setLocalBeat((current) => (current >= maxBeat ? 0 : current + 1))
    }, delay)
    return () => window.clearTimeout(timer)
  }, [beat, controlledBeat, isPlaying, maxBeat, reducedMotion])

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
    <div ref={playbackRef} className={styles.root}>
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
              <PrototypeShell
                scene={scene}
                snapshot={visualSnapshot}
                machineIntroDescription={machineIntroDescription}
                overviewDetails={overviewDetails}
              />
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

export function LandingMobileChatMotion({ beat }: { beat: number }) {
  const snapshot = sceneSnapshot("server", beat)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageScale, setStageScale] = useState(1)
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } }),
  )

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const sync = () => setStageScale(stage.getBoundingClientRect().width / 390)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={stageRef}
      className={styles.mobileStage}
      data-testid="landing-mobile-motion-stage"
      data-beat={snapshot.beat}
      aria-hidden
    >
      <div
        className={styles.mobileCanvas}
        style={{ "--mobile-stage-scale": stageScale } as CSSProperties}
      >
        <div className={styles.mobileTop}>
          <span>9:41</span>
          <span>Phone</span>
        </div>
        <QueryClientProvider client={queryClient}>
          <div className={styles.mobileSurface}>
            <ChannelHeader
              channel="general"
              rightPanel={null}
              onToggle={() => {}}
              onBack={() => {}}
              server={{ id: "gus", name: "Gus", icon: null }}
              tools={{ threads: false, pinned: false, members: false }}
            />
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className={`${styles.mobileMessages} flex-1 overflow-hidden px-2 py-2`}>
                {MESSAGES.map((message, index) => (
                  <div
                    key={message.id}
                    data-visible={index < snapshot.visibleMessages}
                    className={styles.messageSlot}
                  >
                    <div
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
          </div>
        </QueryClientProvider>
      </div>
    </div>
  )
}

function PrototypeShell({
  scene,
  snapshot,
  machineIntroDescription,
  overviewDetails,
}: {
  scene: LandingScene
  snapshot: SceneSnapshot
  machineIntroDescription?: string
  overviewDetails: boolean
}) {
  const continuityRoom = scene === "continuity" && snapshot.beat >= 7
    ? snapshot.room
    : null
  const serverView =
    scene === "server" ||
    scene === "spaces" ||
    scene === "identity" ||
    continuityRoom !== null
  const room = scene === "spaces" || scene === "identity" ? snapshot.room : continuityRoom
  const servers = overviewDetails && scene === "server"
    ? OVERVIEW_SERVERS
    : scene === "continuity"
    ? SPACE_SERVERS.map((server) => ({ ...server, active: server.id === room }))
    : room
    ? SPACE_SERVERS.map((server) => ({ ...server, active: server.id === room }))
    : SERVERS
  return (
    <Shell className={styles.productShell}>
      <PrototypeServerRail
        servers={servers}
        activeServerId={room ?? "gus"}
        serverView={serverView}
      />
      <div className="relative flex min-w-0 flex-1 flex-col pt-2">
        <AppSurface className="rounded-tl-xl rounded-tr-none rounded-br-none rounded-bl-none border-l border-t border-border/40 shadow-none ring-0">
          <div className="flex min-h-0 flex-1">
            <div
              key={`sidebar-${scene}-${room ?? "default"}`}
              className={`flex w-60 shrink-0 flex-col bg-sidebar pb-14 ${styles.sceneEnter}`}
            >
              {serverView ? (
                <PrototypeChannelSidebar
                  room={room}
                  channels={scene === "continuity" ? CONTINUITY_CHANNELS : SPACE_CHANNELS}
                  rootChannels={overviewDetails && scene === "server" ? SPACE_CHANNELS.work : CHANNELS}
                />
              ) : (
                <PrototypeDmSidebar scene={scene} snapshot={snapshot} />
              )}
            </div>
            <div
              key={`content-${scene}-${room ?? "default"}`}
              className={`flex min-w-0 flex-1 flex-col bg-background ${styles.sceneEnter}`}
            >
              {scene === "server" && (
                <ServerScene snapshot={snapshot} showTypingPill={overviewDetails} />
              )}
              {scene === "machine" && (
                <MachineScene
                  snapshot={snapshot}
                  introDescription={machineIntroDescription}
                />
              )}
              {scene === "provider" && <ProviderScene snapshot={snapshot} />}
              {scene === "spaces" && <SpacesScene snapshot={snapshot} />}
              {scene === "identity" && <IdentityScene snapshot={snapshot} />}
              {scene === "continuity" && <ContinuityScene snapshot={snapshot} />}
            </div>
          </div>
        </AppSurface>
        <div className="absolute bottom-0 left-0 z-10 -ml-14 w-74">
          <PrototypeUserBar scene={scene} snapshot={snapshot} />
        </div>
      </div>
    </Shell>
  )
}

function PrototypeUserBar({
  scene,
  snapshot,
}: {
  scene: LandingScene
  snapshot: SceneSnapshot
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const continuityBeat = scene === "continuity" ? snapshot.beat : -1
  const workUnread = continuityBeat === 5 || continuityBeat === 6
  const lifeUnread = continuityBeat === 10 || continuityBeat === 11
  const hasUnread = workUnread || lifeUnread
  const inboxOpen = continuityBeat === 6 || continuityBeat === 11
  const inboxTarget = workUnread
    ? "continuity-inbox-row-work"
    : "continuity-inbox-row-life"
  const inboxChannel = workUnread ? "frontend-design" : "family"
  const unreads = workUnread ? CONTINUITY_WORK_UNREAD : CONTINUITY_LIFE_UNREAD

  useLayoutEffect(() => {
    const root = rootRef.current
    const trigger = root?.querySelector<HTMLElement>('button[aria-label="Inbox"]')
    trigger?.setAttribute("data-motion-target", "continuity-inbox")

    const row = Array.from(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent?.includes(inboxChannel))
    row?.setAttribute("data-motion-target", inboxTarget)

    return () => {
      trigger?.removeAttribute("data-motion-target")
      row?.removeAttribute("data-motion-target")
    }
  }, [inboxChannel, inboxOpen, inboxTarget])

  return (
    <div ref={rootRef} className="relative">
      {inboxOpen && (
        <div className={styles.inboxSurface}>
          <InboxPopover
            unreads={unreads}
            unreadDms={[]}
            mentions={[]}
            marked={[]}
            onOpenForumThread={() => {}}
          />
        </div>
      )}
      <UserBar
        user={{ id: "gus", name: "Gus", avatar: "avatar:beam:gus" }}
        onEditProfile={() => {}}
        inbox={scene === "continuity" || scene === "server" || scene === "machine" ? <span /> : undefined}
        hasUnread={hasUnread}
        inboxOpen={false}
        onInboxOpenChange={() => {}}
      />
    </div>
  )
}

function PrototypeServerRail({
  servers,
  activeServerId,
  serverView,
}: {
  servers: Server[]
  activeServerId: string
  serverView: boolean
}) {
  const railRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const rail = railRef.current
    const targets = ["life", "play"] as const
    for (const id of targets) {
      rail
        ?.querySelector<HTMLElement>(`[data-testid="${tid.serverIcon(id)}"]`)
        ?.setAttribute("data-motion-target", `server-${id}`)
    }
    return () => {
      for (const id of targets) {
        rail
          ?.querySelector<HTMLElement>(`[data-testid="${tid.serverIcon(id)}"]`)
          ?.removeAttribute("data-motion-target")
      }
    }
  }, [servers])

  return (
    <div ref={railRef} className="contents">
      <ServerRail
        servers={servers}
        folders={[]}
        activeServerId={activeServerId}
        view={serverView ? "server" : "dm"}
        bottomInset={60}
        onHome={() => {}}
        onServer={() => {}}
        onServerNavigate={() => {}}
      />
    </div>
  )
}

function PrototypeChannelSidebar({
  room,
  channels = SPACE_CHANNELS,
  rootChannels = CHANNELS,
}: {
  room: LandingRoom | null
  channels?: Record<LandingRoom, Category[]>
  rootChannels?: Category[]
}) {
  const categories = room ? channels[room] : rootChannels
  const tree = useChannelTree(categories)
  const serverName = room
    ? SPACE_SERVERS.find((server) => server.id === room)?.name ?? ""
    : "Gus"
  const activeChannel = categories[0]?.channels[0]?.id ?? "general"
  const sidebarRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!room) return
    const sidebar = sidebarRef.current
    const serverNameElement = Array.from(
      sidebar?.querySelectorAll<HTMLElement>("header span") ?? [],
    ).find((element) => element.textContent?.trim() === serverName)
    const channelElement = sidebar?.querySelector<HTMLElement>(
      `[data-testid="${tid.channelRow(activeChannel)}"]`,
    )
    serverNameElement?.setAttribute(
      "data-motion-target",
      `space-server-name-${room}`,
    )
    channelElement?.setAttribute("data-motion-target", `space-channel-${room}`)
    return () => {
      serverNameElement?.removeAttribute("data-motion-target")
      channelElement?.removeAttribute("data-motion-target")
    }
  }, [activeChannel, room, serverName])

  return (
    <div ref={sidebarRef} className="relative flex min-h-0 flex-1 flex-col">
      <ChannelSidebar
        tree={tree}
        serverName={serverName}
        activeChannel={activeChannel}
        setActiveChannel={() => {}}
        isAdmin={false}
        currentUserId="gus"
      />
      {room && (
        <button
          data-motion-target="invite-life"
          className="absolute right-2 top-2 grid size-7 place-items-center rounded-md text-muted-foreground"
          aria-label="Invite to server"
        >
          <UserPlus className="size-4" />
        </button>
      )}
    </div>
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
  const dmOpen =
    (scene === "provider" && snapshot.beat >= 6) ||
    (scene === "continuity" && snapshot.beat < 5)

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

function ServerScene({
  snapshot,
  showTypingPill,
}: {
  snapshot: SceneSnapshot
  showTypingPill: boolean
}) {
  return (
    <>
      <ChannelHeader
        channel="general"
        rightPanel={null}
        onToggle={() => {}}
        server={{ id: "gus", name: "Gus", icon: null }}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="relative flex-1 overflow-hidden px-4 py-3">
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
          {showTypingPill && <TypingIndicator names={[DMS[0].name]} />}
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

function SpacesScene({ snapshot }: { snapshot: SceneSnapshot }) {
  const room = snapshot.room
  const server = SPACE_SERVERS.find((item) => item.id === room) ?? SPACE_SERVERS[0]
  const channel = SPACE_CHANNELS[room][0]?.channels[0]
  const messages = SPACE_MESSAGES[room]

  return (
    <>
      <ChannelHeader
        channel={channel?.name ?? "general"}
        rightPanel={null}
        onToggle={() => {}}
        server={{ id: server.id, name: server.name, icon: server.icon ?? null }}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden px-4 py-3">
          {messages.map((message, index) => {
            const target = `space-message-${message.authorId}`
            return (
              <div
                key={message.id}
                data-visible={index < snapshot.visibleMessages}
                className={styles.messageSlot}
              >
                <div
                  data-motion-target={target}
                  className={targetClass(snapshot, target)}
                >
                  <Message m={message} onOpenThread={() => {}} />
                </div>
              </div>
            )
          })}
        </div>
        <PrototypeComposer
          snapshot={snapshot}
          target="spaces-composer"
          placeholder={`Message /${channel?.name ?? "general"}`}
        />
      </div>
      <PrototypeInviteSurface snapshot={snapshot} />
    </>
  )
}

function IdentityScene({ snapshot }: { snapshot: SceneSnapshot }) {
  const room = snapshot.room
  const server = SPACE_SERVERS.find((item) => item.id === room) ?? SPACE_SERVERS[0]
  const channel = SPACE_CHANNELS[room][0]?.channels[0]

  return (
    <>
      <ChannelHeader
        channel={channel?.name ?? "general"}
        rightPanel={null}
        onToggle={() => {}}
        server={{ id: server.id, name: server.name, icon: server.icon ?? null }}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden px-4 py-3">
          {IDENTITY_MESSAGES[room].map((message, index) => (
            <div
              key={message.id}
              data-visible={index < snapshot.visibleMessages}
              className={styles.messageSlot}
            >
              <div
                data-motion-target="identity-message-maya"
                className={targetClass(snapshot, "identity-message-maya")}
              >
                <Message m={message} onOpenThread={() => {}} />
              </div>
            </div>
          ))}
        </div>
        <PrototypeComposer
          snapshot={snapshot}
          target="identity-composer"
          placeholder={`Message /${channel?.name ?? "general"}`}
        />
      </div>
    </>
  )
}

function ContinuityScene({ snapshot }: { snapshot: SceneSnapshot }) {
  if (snapshot.beat < 7) {
    return (
      <>
        <DmHeader dm={DMS[0]} titleAs="div" />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden px-4 py-3">
            {CONTINUITY_DM_MESSAGES.map((message, index) => (
              <div
                key={message.id}
                data-visible={index < snapshot.visibleMessages}
                className={styles.messageSlot}
              >
                <div
                  data-motion-target={message.id}
                  className={targetClass(snapshot, message.id)}
                >
                  <Message m={message} onOpenThread={() => {}} />
                </div>
              </div>
            ))}
          </div>
          <PrototypeComposer
            snapshot={snapshot}
            target="continuity-dm-composer"
            placeholder="Message @Alli"
          />
        </div>
      </>
    )
  }

  const room = snapshot.room
  const server = SPACE_SERVERS.find((item) => item.id === room) ?? SPACE_SERVERS[0]
  const channel = CONTINUITY_CHANNELS[room][0]?.channels[0]
  const messages = room === "life"
    ? CONTINUITY_LIFE_MESSAGES
    : CONTINUITY_WORK_MESSAGES

  return (
    <>
      <ChannelHeader
        channel={channel?.name ?? "general"}
        rightPanel={null}
        onToggle={() => {}}
        server={{ id: server.id, name: server.name, icon: server.icon ?? null }}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden px-4 py-3">
          {messages.map((message, index) => (
            <div
              key={message.id}
              data-visible={index < snapshot.visibleMessages}
              className={styles.messageSlot}
            >
              <div
                data-motion-target={message.id}
                className={targetClass(snapshot, message.id)}
              >
                <Message m={message} onOpenThread={() => {}} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function PrototypeInviteSurface({ snapshot }: { snapshot: SceneSnapshot }) {
  return (
    <aside
      aria-label="Invite friends to Home"
      aria-hidden={!snapshot.inviteOpen}
      data-open={snapshot.inviteOpen}
      className={styles.inviteSurface}
    >
      <header className="border-b border-border/50 px-4 py-3">
        <div className="truncate font-heading text-sm font-semibold leading-[1.2] tracking-[-0.015em]">
          Invite friends to Home
        </div>
      </header>
      <div className="px-4 pt-3">
        <label className="relative block">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input readOnly placeholder="Search for friends" className="pl-9" />
        </label>
      </div>
      <div className="px-2 py-2">
        <div className="flex items-center gap-3 rounded-md px-2 py-2">
          <Avatar label="Maya" seed="maya" size={32} presence="online" ringColor="var(--popover)" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">Maya</div>
            <div className="truncate text-xs text-muted-foreground">Free for dinner</div>
          </div>
          <Button
            size="sm"
            variant={snapshot.inviteSent ? "secondary" : "default"}
            data-motion-target="invite-maya"
            className={targetClass(snapshot, "invite-maya")}
          >
            {snapshot.inviteSent ? (
              <>
                <Check className="size-3.5" />
                Invited
              </>
            ) : (
              "Invite"
            )}
          </Button>
        </div>
      </div>
      <footer className="border-t border-border/50 px-4 py-3">
        <div className="text-xs font-medium text-muted-foreground">
          Or, send a server invite link to a friend
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Input readOnly value="alook.ai/c/invite/home" className="font-mono text-xs" />
          <Button size="sm">Copy</Button>
        </div>
      </footer>
    </aside>
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
              <span
                className={styles.typingText}
                style={{ "--typing-width": `${Math.max(11, snapshot.composerText.length)}ch` } as CSSProperties}
              >
                {snapshot.composerText}
              </span>
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

function MachineScene({
  snapshot,
  introDescription,
}: {
  snapshot: SceneSnapshot
  introDescription?: string
}) {
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
              <div className="font-heading text-lg font-medium leading-[1.2] tracking-[-0.015em] text-foreground">
                No machines yet
              </div>
              <p className="max-w-md text-sm text-muted-foreground">
                {introDescription ?? (
                  <>
                    Connect a machine and your bots run on it always-on — reach them from
                    your phone or anywhere, wherever you sign in.
                  </>
                )}
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
              <div className="font-heading text-xl font-medium leading-[1.15] tracking-[-0.015em] text-foreground">
                Machines
              </div>
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
          <div className="font-heading text-lg leading-tight font-semibold tracking-[-0.015em]">
            Connect a machine
          </div>
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
              headingAs="div"
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
            <div className="font-heading text-xl font-medium leading-[1.15] tracking-[-0.015em] text-foreground">
              My Bots
            </div>
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
          <DmHeader dm={DMS[0]} titleAs="div" />
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
          <div className="font-heading text-lg leading-tight font-semibold tracking-[-0.015em]">Edit Alli</div>
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
