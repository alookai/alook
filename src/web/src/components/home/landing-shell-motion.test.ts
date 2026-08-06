import { describe, expect, it } from "vitest"
import {
  LANDING_MACHINE_RUNTIMES,
  SCENE_BEAT_DURATION_MS,
  SCENE_FINAL_HOLD_MS,
  SCENE_MAX_BEAT,
  galleryCameraScale,
  galleryCameraTransform,
  sceneDurationMs,
  sceneSnapshot,
} from "./landing-shell-motion-timeline"

describe("landing shell motion timeline", () => {
  it("reveals the server conversation in causal order", () => {
    expect(sceneSnapshot("server", 1)).toMatchObject({ composerText: "hello world", visibleMessages: 0, focus: "composer" })
    expect(sceneSnapshot("server", 2)).toMatchObject({ visibleMessages: 1, focus: "message-gus" })
    expect(sceneSnapshot("server", 3)).toMatchObject({ visibleMessages: 2, focus: "message-alli" })
    expect(sceneSnapshot("server", 4)).toMatchObject({ visibleMessages: 3, focus: "message-ruth" })
    expect(sceneSnapshot("server", 5)).toMatchObject({ visibleMessages: 4, focus: "message-shelly" })
  })

  it("shows the real pair-sheet steps before the machine and born bot", () => {
    expect(sceneSnapshot("machine", 1)).toMatchObject({ machineState: "empty", pairSheet: "closed", focus: "connect" })
    expect(sceneSnapshot("machine", 2)).toMatchObject({ machineState: "connecting", pairSheet: "command", focus: "pair-step-1" })
    expect(sceneSnapshot("machine", 3)).toMatchObject({ machineState: "connecting", pairSheet: "waiting", focus: "pair-step-2" })
    expect(sceneSnapshot("machine", 4)).toMatchObject({ machineState: "online", pairSheet: "connected", focus: "pair-connected" })
    expect(sceneSnapshot("machine", 5)).toMatchObject({ machineState: "online", pairSheet: "closed", focus: "machine" })
    expect(sceneSnapshot("machine", 6)).toMatchObject({ machineState: "bot-born", pairSheet: "closed", focus: "born-bot" })
  })

  it("uses the five providers reported by the landing machine fixture", () => {
    expect(LANDING_MACHINE_RUNTIMES).toEqual([
      "claude",
      "codex",
      "cursor",
      "opencode",
      "pi",
    ])
  })

  it("switches provider, closes the sheet, opens Alli's DM, and sends a message", () => {
    expect(sceneSnapshot("provider", 1)).toMatchObject({ runtime: "claude", focus: "bot-actions" })
    expect(sceneSnapshot("provider", 2)).toMatchObject({ runtime: "claude", focus: "bot-edit" })
    expect(sceneSnapshot("provider", 3)).toMatchObject({ runtime: "claude", model: null, focus: "runtime-codex", camera: { scale: 1.22 } })
    expect(sceneSnapshot("provider", 4)).toMatchObject({ runtime: "codex", model: null, focus: "save-provider" })
    expect(sceneSnapshot("provider", 5)).toMatchObject({ runtime: "codex", model: null, focus: "dm-alli", camera: { scale: 1 } })
    expect(sceneSnapshot("provider", 6)).toMatchObject({ composerText: "hello Alli", visibleMessages: 0, focus: "dm-composer", camera: { scale: 1.18 } })
    expect(sceneSnapshot("provider", 7)).toMatchObject({ composerText: "", visibleMessages: 1, focus: "dm-message-gus" })
    expect(sceneSnapshot("provider", 8)).toMatchObject({ visibleMessages: 2, focus: "dm-message-alli", camera: { scale: 1.18 } })
    expect(sceneSnapshot("provider", 9)).toMatchObject({ visibleMessages: 2, focus: null, camera: { scale: 1 } })
  })

  it("zooms in around the cursor and returns wide in all three acts", () => {
    expect(sceneSnapshot("server", 1).camera.scale).toBe(1.22)
    expect(sceneSnapshot("server", 6).camera.scale).toBe(1)
    expect(sceneSnapshot("machine", 2).camera.scale).toBe(1.22)
    expect(sceneSnapshot("machine", 7).camera.scale).toBe(1)
    expect(sceneSnapshot("provider", 3).camera.scale).toBe(1.22)
    expect(sceneSnapshot("provider", 5).camera.scale).toBe(1)
    expect(sceneSnapshot("provider", 6).camera.scale).toBe(1.18)
    expect(sceneSnapshot("provider", 9).camera.scale).toBe(1)
  })

  it("clamps out-of-range beats to a valid deterministic snapshot", () => {
    expect(sceneSnapshot("server", -1).beat).toBe(0)
    expect(sceneSnapshot("server", 99).beat).toBe(SCENE_MAX_BEAT.server)
    expect(sceneSnapshot("machine", 99).machineState).toBe("bot-born")
  })

  it("exposes each act's complete playback duration to gallery consumers", () => {
    expect(sceneDurationMs("server")).toBe(
      SCENE_MAX_BEAT.server * SCENE_BEAT_DURATION_MS + SCENE_FINAL_HOLD_MS,
    )
    expect(sceneDurationMs("machine")).toBe(12_900)
    expect(sceneDurationMs("provider")).toBe(15_900)
  })

  it("boosts focused gallery beats while preserving wide beats", () => {
    expect(galleryCameraScale(1)).toBe(1)
    expect(galleryCameraScale(1.18)).toBe(1.6)
    expect(galleryCameraScale(1.22)).toBe(1.6)
  })

  it("keeps bottom-edge focus targets inside the gallery camera", () => {
    const camera = galleryCameraTransform(
      { scale: 1.18, x: 700, y: 570 },
      { x: 700, y: 620 },
    )
    const transformedFocusY = camera.y + camera.scale * (620 - camera.y)

    expect(camera.scale).toBe(1.6)
    expect(transformedFocusY).toBeCloseTo(660 * 0.74)
  })

  it("waits at wide view until the live focus target is resolved", () => {
    expect(
      galleryCameraTransform({ scale: 1.22, x: 900, y: 510 }, null),
    ).toMatchObject({ scale: 1 })
  })
})
