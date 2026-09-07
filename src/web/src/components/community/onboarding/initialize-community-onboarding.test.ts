import { beforeEach, describe, expect, it, vi } from "vitest"

const { apiFetch, randomBotName, randomBeamAvatar } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  randomBotName: vi.fn(),
  randomBeamAvatar: vi.fn(),
}))

vi.mock("@/lib/api/client", () => ({ apiFetch }))
vi.mock("@/lib/avatar/seed-url", () => ({ randomBeamAvatar }))
vi.mock("@/lib/community/bot-random-name", () => ({ randomBotName }))

import {
  initializeCommunityOnboarding,
  onboardingRoomName,
  type OnboardingInitializationCheckpoint,
} from "./initialize-community-onboarding"
import { resolveStarterPack } from "./starter-packs"

describe("initializeCommunityOnboarding", () => {
  beforeEach(() => {
    apiFetch.mockReset()
    randomBotName.mockReset().mockReturnValueOnce("Ari").mockReturnValueOnce("Bo")
    randomBeamAvatar
      .mockReset()
      .mockReturnValueOnce("avatar:beam:avatar-a")
      .mockReturnValueOnce("avatar:beam:avatar-b")
      .mockReturnValueOnce("avatar:beam:avatar-c")
  })

  it("creates the three-bot development pack with one shared backend and distinct wake prompts", async () => {
    const pack = resolveStarterPack("developer")
    apiFetch
      .mockResolvedValueOnce({ bot: { id: "bot-lin", discriminator: "0001" } })
      .mockResolvedValueOnce({ bot: { id: "bot-kit", discriminator: "0002" } })
      .mockResolvedValueOnce({ bot: { id: "bot-moss", discriminator: "0003" } })
      .mockResolvedValueOnce({ server: { id: "server-1" } })
      .mockResolvedValueOnce({
        channels: [
          { id: "public-1", name: "all" },
          { id: "private-1", name: "room" },
        ],
      })
      .mockResolvedValueOnce({ onboarded: 1, finalized: false })
      .mockResolvedValueOnce({ onboarded: 1, finalized: false })
      .mockResolvedValueOnce({ onboarded: 1, finalized: false })
      .mockResolvedValueOnce({ onboarded: 0, finalized: true })
      .mockResolvedValueOnce({ ok: true })

    const checkpoints: OnboardingInitializationCheckpoint[] = []
    const result = await initializeCommunityOnboarding({
      machineId: "machine-1",
      runtime: "codex",
      identity: "developer",
      userName: "Ada Lovelace",
      userDiscriminator: "0042",
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    })

    expect(result).toMatchObject({
      serverId: "server-1",
      publicChannelId: "public-1",
      privateChannelId: "private-1",
      leadBotId: "bot-lin",
      bots: [
        { key: "lead", id: "bot-lin", name: "Lin", discriminator: "0001" },
        { key: "doer", id: "bot-kit", name: "Kit", discriminator: "0002" },
        { key: "reviewer", id: "bot-moss", name: "Moss", discriminator: "0003" },
      ],
    })
    expect(apiFetch).toHaveBeenCalledTimes(10)
    for (const [index, template] of pack.bots.entries()) {
      expect(apiFetch).toHaveBeenNthCalledWith(index + 1, "/api/community/bots", {
        method: "POST",
        body: JSON.stringify({
          name: template.name,
          description: template.publicBio,
          machineId: "machine-1",
          runtime: "codex",
          image: `avatar:beam:avatar-${String.fromCharCode(97 + index)}`,
        }),
      })
    }
    const onboardPayload = JSON.parse(apiFetch.mock.calls[5]![1].body)
    expect(onboardPayload.leadBotId).toBe("bot-lin")
    expect(onboardPayload.bots.map((bot: { id: string }) => bot.id)).toEqual([
      "bot-lin",
      "bot-kit",
      "bot-moss",
    ])
    expect(onboardPayload.bots[0].wakePrompt).toContain("You are the Lead")
    expect(onboardPayload.bots[0].wakePrompt).toContain("@Ada Lovelace#0042")
    expect(onboardPayload.bots[1].wakePrompt).toContain("Send exactly one short sentence")
    expect(onboardPayload.bots[2].wakePrompt).toContain("You are the Reviewer")
    expect(apiFetch.mock.calls.slice(5, 8).map((call) => JSON.parse(call[1].body).action)).toEqual([
      { type: "wake", botId: "bot-lin" },
      { type: "wake", botId: "bot-kit" },
      { type: "wake", botId: "bot-moss" },
    ])
    expect(JSON.parse(apiFetch.mock.calls[8]![1].body).action).toEqual({ type: "finalize" })
    expect(apiFetch).toHaveBeenNthCalledWith(10, "/api/community/channels/private-1/members", {
      method: "POST",
      body: JSON.stringify({ userId: "bot-lin" }),
    })
    expect(checkpoints.at(-1)).toMatchObject({
      botsOnboarded: true,
      leadAddedToPrivate: true,
    })
  })

  it("uses a simple random-named Lead and Doer for a custom role", async () => {
    apiFetch
      .mockResolvedValueOnce({ bot: { id: "bot-a", discriminator: "0001" } })
      .mockResolvedValueOnce({ bot: { id: "bot-b", discriminator: "0002" } })
      .mockResolvedValueOnce({ server: { id: "server-1" } })
      .mockResolvedValueOnce({
        channels: [
          { id: "public-1", name: "all" },
          { id: "private-1", name: "room" },
        ],
      })
      .mockResolvedValueOnce({ onboarded: 1, finalized: false })
      .mockResolvedValueOnce({ onboarded: 1, finalized: false })
      .mockResolvedValueOnce({ onboarded: 0, finalized: true })
      .mockResolvedValueOnce({ ok: true })

    const result = await initializeCommunityOnboarding({
      machineId: "machine-1",
      runtime: "claude",
      identity: "ceramics studio",
      userName: "Ada",
    })

    expect(result.bots).toMatchObject([
      { key: "lead", name: "Ari" },
      { key: "doer", name: "Bo" },
    ])
    expect(randomBotName).toHaveBeenCalledTimes(2)
    const createBodies = apiFetch.mock.calls.slice(0, 2).map((call) => JSON.parse(call[1].body))
    expect(createBodies.map(({ runtime }) => runtime)).toEqual(["claude", "claude"])
    expect(createBodies.map(({ description }) => description)).toEqual([
      "Leads requests from a clear brief to a finished result.",
      "Does focused work and reports concrete, checkable results.",
    ])
  })

  it("resumes from a checkpoint without duplicating created resources or messages", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true })

    await initializeCommunityOnboarding({
      machineId: "machine-1",
      runtime: "codex",
      identity: "founder",
      userName: "Grace",
      checkpoint: {
        bots: [
          { key: "lead", id: "bot-a", name: "Maya", discriminator: "0001" },
          { key: "doer", id: "bot-b", name: "Sol", discriminator: "0002" },
        ],
        serverId: "server-1",
        publicChannelId: "public-1",
        privateChannelId: "private-1",
        botsOnboarded: true,
      },
    })

    expect(apiFetch).toHaveBeenCalledOnce()
    expect(apiFetch).toHaveBeenCalledWith("/api/community/channels/private-1/members", {
      method: "POST",
      body: JSON.stringify({ userId: "bot-a" }),
    })
  })

  it("retries a failed second wake without waking the first bot again", async () => {
    const checkpoints: OnboardingInitializationCheckpoint[] = []
    const checkpoint: OnboardingInitializationCheckpoint = {
      bots: [
        { key: "lead", id: "bot-a", name: "Maya", discriminator: "0001" },
        { key: "doer", id: "bot-b", name: "Sol", discriminator: "0002" },
      ],
      serverId: "server-1",
      publicChannelId: "public-1",
      privateChannelId: "private-1",
    }
    apiFetch
      .mockResolvedValueOnce({ onboarded: 1, finalized: false })
      .mockRejectedValueOnce(new Error("machine is offline"))

    await expect(initializeCommunityOnboarding({
      machineId: "machine-1",
      runtime: "codex",
      identity: "founder",
      userName: "Grace",
      checkpoint,
      onCheckpoint: (next) => checkpoints.push(next),
    })).rejects.toThrow("machine is offline")

    const resumedCheckpoint = checkpoints.at(-1)!
    expect(resumedCheckpoint.onboardedBotIds).toEqual(["bot-a"])
    apiFetch
      .mockResolvedValueOnce({ onboarded: 1, finalized: false })
      .mockResolvedValueOnce({ onboarded: 0, finalized: true })
      .mockResolvedValueOnce({ ok: true })

    await initializeCommunityOnboarding({
      machineId: "machine-1",
      runtime: "codex",
      identity: "founder",
      userName: "Grace",
      checkpoint: resumedCheckpoint,
    })

    const actions = apiFetch.mock.calls
      .filter(([path]) => path === "/api/community/servers/server-1/onboard")
      .map((call) => JSON.parse(call[1].body).action)
    expect(actions).toEqual([
      { type: "wake", botId: "bot-a" },
      { type: "wake", botId: "bot-b" },
      { type: "wake", botId: "bot-b" },
      { type: "finalize" },
    ])
  })

  it("rejects a checkpoint that cannot restore the complete selected team", async () => {
    apiFetch
      .mockResolvedValueOnce({ bot: { id: "" } })
      .mockResolvedValueOnce({ bot: { id: "bot-kit" } })
      .mockResolvedValueOnce({ bot: { id: "bot-moss" } })

    await expect(initializeCommunityOnboarding({
      machineId: "machine-1",
      runtime: "codex",
      identity: "developer",
      userName: "Ada",
    })).rejects.toThrow("Setup progress could not be restored")
  })

  it("rejects a room whose default channels are missing", async () => {
    apiFetch.mockResolvedValueOnce({ channels: [] })

    await expect(initializeCommunityOnboarding({
      machineId: "machine-1",
      runtime: "codex",
      identity: "home",
      userName: "Ada",
      checkpoint: {
        bots: [
          { key: "lead", id: "bot-a", name: "Olive" },
          { key: "doer", id: "bot-b", name: "Poppy" },
        ],
        serverId: "server-1",
      },
    })).rejects.toThrow("The new room is missing its default channels")
  })

  it("rejects default channels whose ids cannot be restored", async () => {
    apiFetch.mockResolvedValueOnce({
      channels: [
        { id: "", name: "all" },
        { id: "", name: "room" },
      ],
    })

    await expect(initializeCommunityOnboarding({
      machineId: "machine-1",
      runtime: "codex",
      identity: "home",
      userName: "Ada",
      checkpoint: {
        bots: [
          { key: "lead", id: "bot-a", name: "Olive" },
          { key: "doer", id: "bot-b", name: "Poppy" },
        ],
        serverId: "server-1",
      },
    })).rejects.toThrow("Default channels could not be restored")
  })

  it("maps each identity to a stable room name", () => {
    expect(onboardingRoomName("Ada", "developer")).toBe("Ada-dev-room")
    expect(onboardingRoomName("Gus Ye", "founder")).toBe("Gus-Ye-founder-room")
    expect(onboardingRoomName("", "home")).toBe("home-room")
    expect(onboardingRoomName("Ada", "unknown")).toBe("Ada-team-room")
  })

  it("keeps generated room names inside the server-name limit", () => {
    const name = onboardingRoomName("a".repeat(200), "founder")
    expect(name).toHaveLength(100)
    expect(name).toMatch(/-founder-room$/)
  })
})
