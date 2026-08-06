export type LandingScene = "server" | "machine" | "provider"

export const LANDING_MACHINE_RUNTIMES = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "pi",
] as const

export const SCENE_MAX_BEAT: Record<LandingScene, number> = {
  server: 6,
  machine: 7,
  provider: 9,
}

export const SCENE_BEAT_DURATION_MS = 1500
export const SCENE_FINAL_HOLD_MS = 2400

export function sceneDurationMs(scene: LandingScene) {
  return SCENE_MAX_BEAT[scene] * SCENE_BEAT_DURATION_MS + SCENE_FINAL_HOLD_MS
}

export function galleryCameraScale(scale: number) {
  return scale <= 1 ? scale : 1.6
}

export function galleryCameraTransform(
  camera: { scale: number; x: number; y: number },
  focus: { x: number; y: number } | null,
) {
  const scale = galleryCameraScale(camera.scale)
  if (scale <= 1) return { ...camera, scale }
  if (!focus) return { ...camera, scale: 1 }

  const desiredX = Math.min(Math.max(focus.x, 1120 * 0.28), 1120 * 0.72)
  const desiredY = Math.min(Math.max(focus.y, 660 * 0.24), 660 * 0.74)
  return {
    scale,
    x: (scale * focus.x - desiredX) / (scale - 1),
    y: (scale * focus.y - desiredY) / (scale - 1),
  }
}

export type SceneSnapshot = {
  beat: number
  visibleMessages: number
  composerText: string
  machineState: "empty" | "connecting" | "online" | "bot-born"
  pairSheet: "closed" | "command" | "waiting" | "connected"
  runtime: "claude" | "codex"
  model: string | null
  focus: string | null
  camera: { scale: number; x: number; y: number }
}

const WIDE_CAMERA = { scale: 1, x: 560, y: 330 }
const SERVER_CAMERAS = [
  WIDE_CAMERA,
  { scale: 1.22, x: 700, y: 570 },
  { scale: 1.18, x: 620, y: 110 },
  { scale: 1.18, x: 620, y: 190 },
  { scale: 1.18, x: 620, y: 270 },
  { scale: 1.18, x: 620, y: 350 },
  WIDE_CAMERA,
]
const MACHINE_CAMERAS = [
  WIDE_CAMERA,
  { scale: 1.2, x: 900, y: 90 },
  { scale: 1.22, x: 900, y: 180 },
  { scale: 1.22, x: 900, y: 360 },
  { scale: 1.22, x: 900, y: 510 },
  { scale: 1.18, x: 620, y: 160 },
  { scale: 1.18, x: 620, y: 360 },
  WIDE_CAMERA,
]
const PROVIDER_CAMERAS = [
  WIDE_CAMERA,
  { scale: 1.18, x: 980, y: 170 },
  { scale: 1.2, x: 950, y: 300 },
  { scale: 1.22, x: 900, y: 360 },
  { scale: 1.22, x: 930, y: 600 },
  WIDE_CAMERA,
  { scale: 1.18, x: 700, y: 570 },
  { scale: 1.18, x: 620, y: 140 },
  { scale: 1.18, x: 620, y: 230 },
  WIDE_CAMERA,
]

export function sceneSnapshot(scene: LandingScene, requestedBeat: number): SceneSnapshot {
  const beat = Math.max(0, Math.min(requestedBeat, SCENE_MAX_BEAT[scene]))
  if (scene === "server") {
    return {
      beat,
      visibleMessages: beat < 2 ? 0 : Math.min(4, beat - 1),
      composerText: beat === 1 ? "hello world" : "",
      machineState: "empty",
      pairSheet: "closed",
      runtime: "claude",
      model: null,
      focus: [null, "composer", "message-gus", "message-alli", "message-ruth", "message-shelly"][beat] ?? null,
      camera: SERVER_CAMERAS[beat] ?? WIDE_CAMERA,
    }
  }
  if (scene === "machine") {
    return {
      beat,
      visibleMessages: 0,
      composerText: "",
      machineState:
        beat < 2
          ? "empty"
          : beat < 4
            ? "connecting"
            : beat < 6
              ? "online"
              : "bot-born",
      pairSheet:
        beat === 2
          ? "command"
          : beat === 3
            ? "waiting"
            : beat === 4
              ? "connected"
              : "closed",
      runtime: "claude",
      model: null,
      focus: [
        null,
        "connect",
        "pair-step-1",
        "pair-step-2",
        "pair-connected",
        "machine",
        "born-bot",
      ][beat] ?? null,
      camera: MACHINE_CAMERAS[beat] ?? WIDE_CAMERA,
    }
  }
  return {
    beat,
    visibleMessages: beat >= 8 ? 2 : beat >= 7 ? 1 : 0,
    composerText: beat === 6 ? "hello Alli" : "",
    machineState: "online",
    pairSheet: "closed",
    runtime: beat >= 4 ? "codex" : "claude",
    model: null,
    focus: [
      null,
      "bot-actions",
      "bot-edit",
      "runtime-codex",
      "save-provider",
      "dm-alli",
      "dm-composer",
      "dm-message-gus",
      "dm-message-alli",
    ][beat] ?? null,
    camera: PROVIDER_CAMERAS[beat] ?? WIDE_CAMERA,
  }
}
