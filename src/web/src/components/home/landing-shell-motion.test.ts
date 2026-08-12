import { describe, expect, it } from "vitest"
import {
  LANDING_MACHINE_RUNTIMES,
  LANDING_IDENTITY_MAYA,
  SCENE_BEAT_DURATION_MS,
  SCENE_FINAL_HOLD_MS,
  SCENE_MAX_BEAT,
  galleryCameraScale,
  galleryCameraTransform,
  sceneDurationMs,
  sceneSnapshot,
} from "./landing-shell-motion-timeline"
import {
  LANDING_MOTION_VISIBILITY_THRESHOLD,
  landingMotionVisibility,
  shouldPlayLandingMotion,
} from "./use-landing-motion-playback"

describe("landing shell motion timeline", () => {
  it("reveals the server conversation in causal order", () => {
    expect(sceneSnapshot("server", 1)).toMatchObject({ composerText: "hello world", visibleMessages: 0, focus: "composer" })
    expect(sceneSnapshot("server", 2)).toMatchObject({ visibleMessages: 1, focus: "message-gus" })
    expect(sceneSnapshot("server", 3)).toMatchObject({ visibleMessages: 2, focus: "message-alli" })
    expect(sceneSnapshot("server", 4)).toMatchObject({ visibleMessages: 3, focus: "message-ruth" })
    expect(sceneSnapshot("server", 5)).toMatchObject({ visibleMessages: 4, focus: "message-shelly" })
  })

  it("provides one deterministic Case 1 timeline for desktop and mobile consumers", () => {
    const sharedBeats = Array.from({ length: SCENE_MAX_BEAT.server + 1 }, (_, beat) =>
      sceneSnapshot("server", beat),
    )

    expect(sharedBeats.map(({ beat, composerText, visibleMessages }) => ({ beat, composerText, visibleMessages }))).toEqual([
      { beat: 0, composerText: "", visibleMessages: 0 },
      { beat: 1, composerText: "hello world", visibleMessages: 0 },
      { beat: 2, composerText: "", visibleMessages: 1 },
      { beat: 3, composerText: "", visibleMessages: 2 },
      { beat: 4, composerText: "", visibleMessages: 3 },
      { beat: 5, composerText: "", visibleMessages: 4 },
      { beat: 6, composerText: "", visibleMessages: 4 },
    ])
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

  it("switches isolated rooms, invites a friend, and lands in play with its bot", () => {
    expect(sceneSnapshot("spaces", 0)).toMatchObject({ room: "work", inviteOpen: false, focus: null })
    expect(sceneSnapshot("spaces", 1)).toMatchObject({ room: "work", focus: "server-life" })
    expect(sceneSnapshot("spaces", 2)).toMatchObject({ room: "life", focus: "space-server-name-life" })
    expect(sceneSnapshot("spaces", 3)).toMatchObject({ room: "life", focus: "space-channel-life" })
    expect(sceneSnapshot("spaces", 4)).toMatchObject({ room: "life", focus: "invite-life" })
    expect(sceneSnapshot("spaces", 5)).toMatchObject({ room: "life", inviteOpen: true, inviteSent: false, focus: "invite-maya" })
    expect(sceneSnapshot("spaces", 6)).toMatchObject({ room: "life", inviteOpen: true, inviteSent: true, focus: "invite-maya" })
    expect(sceneSnapshot("spaces", 7)).toMatchObject({ room: "life", inviteOpen: false, visibleMessages: 3, focus: "space-message-maya" })
    expect(sceneSnapshot("spaces", 8)).toMatchObject({ room: "life", focus: "server-play" })
    expect(sceneSnapshot("spaces", 9)).toMatchObject({ room: "play", focus: "space-server-name-play" })
    expect(sceneSnapshot("spaces", 10)).toMatchObject({ room: "play", focus: "space-channel-play" })
    expect(sceneSnapshot("spaces", 11)).toMatchObject({ room: "play", visibleMessages: 3, focus: "space-message-quest" })
    expect(sceneSnapshot("spaces", 12)).toMatchObject({ room: "play", focus: null, camera: { scale: 1 } })
  })

  it("shows the same Maya identity across Studio, Home, and Game Night", () => {
    expect(LANDING_IDENTITY_MAYA).toEqual({
      authorId: "maya",
      authorName: "Maya",
      authorAvatar: "avatar:beam:maya",
      content: "I’m here.",
    })
    expect(sceneSnapshot("identity", 0)).toMatchObject({ room: "work", visibleMessages: 0, focus: null })
    expect(sceneSnapshot("identity", 1)).toMatchObject({ room: "work", visibleMessages: 0, focus: "space-server-name-work" })
    expect(sceneSnapshot("identity", 2)).toMatchObject({ room: "work", visibleMessages: 0, focus: "space-channel-work" })
    expect(sceneSnapshot("identity", 3)).toMatchObject({ room: "work", visibleMessages: 1, focus: "identity-message-maya" })
    expect(sceneSnapshot("identity", 4)).toMatchObject({ room: "work", visibleMessages: 1, focus: "server-life" })
    expect(sceneSnapshot("identity", 5)).toMatchObject({ room: "life", visibleMessages: 0, focus: "space-server-name-life" })
    expect(sceneSnapshot("identity", 6)).toMatchObject({ room: "life", visibleMessages: 0, focus: "space-channel-life" })
    expect(sceneSnapshot("identity", 7)).toMatchObject({ room: "life", visibleMessages: 1, focus: "identity-message-maya" })
    expect(sceneSnapshot("identity", 8)).toMatchObject({ room: "life", visibleMessages: 1, focus: "server-play" })
    expect(sceneSnapshot("identity", 9)).toMatchObject({ room: "play", visibleMessages: 0, focus: "space-server-name-play" })
    expect(sceneSnapshot("identity", 10)).toMatchObject({ room: "play", visibleMessages: 0, focus: "space-channel-play" })
    expect(sceneSnapshot("identity", 11)).toMatchObject({ room: "play", visibleMessages: 1, focus: "identity-message-maya" })
    expect(sceneSnapshot("identity", 12)).toMatchObject({ room: "play", visibleMessages: 1, focus: null, camera: { scale: 1 } })
  })

  it("turns one Gus request into two proactive exchanges discovered through unread inbox items", () => {
    expect(sceneSnapshot("continuity", 0)).toMatchObject({ room: "work", visibleMessages: 0, focus: null })
    expect(sceneSnapshot("continuity", 1)).toMatchObject({ composerText: "Alli, please move today’s priorities forward.", visibleMessages: 0, focus: "continuity-dm-composer" })
    expect(sceneSnapshot("continuity", 2)).toMatchObject({ composerText: "", visibleMessages: 1, focus: "continuity-dm-gus" })
    expect(sceneSnapshot("continuity", 3)).toMatchObject({ visibleMessages: 2, focus: "continuity-dm-alli" })
    expect(sceneSnapshot("continuity", 4)).toMatchObject({ focus: null, camera: { scale: 1 } })
    expect(sceneSnapshot("continuity", 5)).toMatchObject({ room: "work", visibleMessages: 2, focus: "continuity-inbox" })
    expect(sceneSnapshot("continuity", 6)).toMatchObject({ room: "work", visibleMessages: 2, focus: "continuity-inbox-row-work" })

    expect(sceneSnapshot("continuity", 7)).toMatchObject({ visibleMessages: 1, focus: "continuity-work-alli" })
    expect(sceneSnapshot("continuity", 8)).toMatchObject({ visibleMessages: 2, focus: "continuity-work-shelly" })
    expect(sceneSnapshot("continuity", 9)).toMatchObject({ focus: null, camera: { scale: 1 } })
    expect(sceneSnapshot("continuity", 10)).toMatchObject({ room: "work", visibleMessages: 2, focus: "continuity-inbox" })
    expect(sceneSnapshot("continuity", 11)).toMatchObject({ room: "work", visibleMessages: 2, focus: "continuity-inbox-row-life" })

    expect(sceneSnapshot("continuity", 12)).toMatchObject({ room: "life", visibleMessages: 2, focus: "continuity-life-alli" })
    expect(sceneSnapshot("continuity", 13)).toMatchObject({ visibleMessages: 2, focus: "continuity-life-tracy" })
    expect(sceneSnapshot("continuity", 14)).toMatchObject({ focus: null, camera: { scale: 1 } })
    expect(
      Array.from({ length: 8 }, (_, index) => sceneSnapshot("continuity", index + 7).composerText),
    ).toEqual(Array.from({ length: 8 }, () => ""))
  })

  it("zooms in around the cursor and returns wide in every shell act", () => {
    expect(sceneSnapshot("server", 1).camera.scale).toBe(1.22)
    expect(sceneSnapshot("server", 6).camera.scale).toBe(1)
    expect(sceneSnapshot("machine", 2).camera.scale).toBe(1.22)
    expect(sceneSnapshot("machine", 7).camera.scale).toBe(1)
    expect(sceneSnapshot("provider", 3).camera.scale).toBe(1.22)
    expect(sceneSnapshot("provider", 5).camera.scale).toBe(1)
    expect(sceneSnapshot("provider", 6).camera.scale).toBe(1.18)
    expect(sceneSnapshot("provider", 9).camera.scale).toBe(1)
    expect(sceneSnapshot("spaces", 5).camera.scale).toBe(1.2)
    expect(sceneSnapshot("spaces", 12).camera.scale).toBe(1)
    expect(sceneSnapshot("identity", 3).camera.scale).toBe(1.18)
    expect(sceneSnapshot("identity", 12).camera.scale).toBe(1)
    expect(sceneSnapshot("continuity", 6).camera.scale).toBe(1.2)
    expect(sceneSnapshot("continuity", 14).camera.scale).toBe(1)
  })

  it("clamps out-of-range beats to a valid deterministic snapshot", () => {
    expect(sceneSnapshot("server", -1).beat).toBe(0)
    expect(sceneSnapshot("server", 99).beat).toBe(SCENE_MAX_BEAT.server)
    expect(sceneSnapshot("machine", 99).machineState).toBe("bot-born")
    expect(sceneSnapshot("spaces", 99)).toMatchObject({ room: "play", inviteSent: true })
    expect(sceneSnapshot("identity", 99)).toMatchObject({ room: "play", inviteOpen: false })
  })

  it("exposes each act's complete playback duration to gallery consumers", () => {
    expect(sceneDurationMs("server")).toBe(
      SCENE_MAX_BEAT.server * SCENE_BEAT_DURATION_MS + SCENE_FINAL_HOLD_MS,
    )
    expect(sceneDurationMs("machine")).toBe(12_900)
    expect(sceneDurationMs("provider")).toBe(15_900)
    expect(sceneDurationMs("spaces")).toBe(20_400)
    expect(sceneDurationMs("identity")).toBe(20_400)
    expect(sceneDurationMs("continuity")).toBe(23_400)
  })

  it("pauses below 30% visibility without marking the scene for reset", () => {
    expect(LANDING_MOTION_VISIBILITY_THRESHOLD).toBe(0.3)
    expect(landingMotionVisibility({ isIntersecting: true, intersectionRatio: 0.001 })).toBe("paused")
    expect(landingMotionVisibility({ isIntersecting: true, intersectionRatio: 0.299 })).toBe("paused")
    expect(shouldPlayLandingMotion({ isIntersecting: true, intersectionRatio: 0.299 })).toBe(false)
  })

  it("resets only once the frame has completely left the viewport", () => {
    expect(landingMotionVisibility({ isIntersecting: false, intersectionRatio: 0 })).toBe("hidden")
    expect(landingMotionVisibility({ isIntersecting: true, intersectionRatio: 0 })).toBe("hidden")
  })

  it("restarts from the reset beat after re-entering at 30% visibility", () => {
    const visibilitySequence = [
      landingMotionVisibility({ isIntersecting: false, intersectionRatio: 0 }),
      landingMotionVisibility({ isIntersecting: true, intersectionRatio: 0.12 }),
      landingMotionVisibility({ isIntersecting: true, intersectionRatio: 0.3 }),
    ]

    expect(visibilitySequence).toEqual(["hidden", "paused", "playing"])
    expect(shouldPlayLandingMotion({ isIntersecting: true, intersectionRatio: 0.3 })).toBe(true)
    expect(shouldPlayLandingMotion({ isIntersecting: false, intersectionRatio: 0.8 })).toBe(false)
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
