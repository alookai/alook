import React from "react"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BotSummary } from "@/hooks/community/use-bots"
import type { BotListController } from "./bot-list-types"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const readWebSource = (path: string) => readFileSync(resolve(webRoot, path), "utf8")

const mocks = vi.hoisted(() => ({
  hookOrder: [] as string[],
  target: "mac1" as string | null,
  audit: null as string | null,
  bots: [] as BotSummary[],
  botsDataReady: true,
  machines: [] as Array<Record<string, unknown>>,
  botsLoading: false,
  machinesLoading: false,
  online: new Set<string>(),
  onboardingSnapshot: null as Record<string, unknown> | null,
  actionState: null as Record<string, unknown> | null,
  push: vi.fn(),
  replace: vi.fn(),
  createDm: vi.fn(),
  del: vi.fn(),
  resetBot: vi.fn(),
  resetMachine: vi.fn(),
  advance: vi.fn(),
  updateResources: vi.fn(),
  recoverMachine: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastApiError: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => {
    mocks.hookOrder.push("router")
    return { push: mocks.push, replace: mocks.replace }
  },
  useSearchParams: () => {
    mocks.hookOrder.push("searchParams")
    return {
      get: (key: string) => key === "machineId" ? mocks.target : mocks.audit,
      toString: () => {
        const params = new URLSearchParams()
        if (mocks.target) params.set("machineId", mocks.target)
        if (mocks.audit) params.set("audit", mocks.audit)
        return params.toString()
      },
    }
  },
}))
vi.mock("@/hooks/community/use-bots", () => ({
  useBots: () => {
    mocks.hookOrder.push("bots")
    return {
      bots: mocks.bots,
      data: mocks.botsDataReady ? { bots: mocks.bots } : undefined,
      isLoading: mocks.botsLoading,
    }
  },
  useDeleteBot: () => {
    mocks.hookOrder.push("delete")
    return { mutateAsync: mocks.del }
  },
  useResetBotSession: () => {
    mocks.hookOrder.push("resetBot")
    return { mutateAsync: mocks.resetBot }
  },
  useResetMachineAgents: () => {
    mocks.hookOrder.push("resetMachine")
    return { mutateAsync: mocks.resetMachine }
  },
}))
vi.mock("@/hooks/community/use-machines", () => ({
  useMachines: () => {
    mocks.hookOrder.push("machines")
    return { machines: mocks.machines, isLoading: mocks.machinesLoading }
  },
}))
vi.mock("@/stores/community/ws", () => ({
  useProfilesByUserId: () => {
    mocks.hookOrder.push("profiles")
    return new Map([...mocks.online].map((id) => [id, { id, presence: "online" }]))
  },
}))
vi.mock("@/hooks/community/mutations", () => ({
  useCreateOrGetDm: () => {
    mocks.hookOrder.push("dm")
    return { mutateAsync: mocks.createDm }
  },
}))
vi.mock("@/lib/community-onboarding", () => ({
  useCommunityOnboarding: () => {
    mocks.hookOrder.push("onboarding")
    return mocks.onboardingSnapshot
  },
  readCommunityOnboardingState: () => mocks.actionState,
  advanceCommunityOnboarding: mocks.advance,
  updateCommunityOnboardingResources: mocks.updateResources,
  recoverCommunityOnboardingMachine: mocks.recoverMachine,
}))
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))
vi.mock("@/lib/api/client", () => ({ toastApiError: mocks.toastApiError }))

import { useBotListController } from "./bot-list-controller"

let latest: BotListController
function Probe() {
  const controller = useBotListController()
  React.useLayoutEffect(() => {
    latest = controller
  }, [controller])
  return React.createElement("div", {
    ref: (element: HTMLDivElement | null) => {
      Reflect.set(controller.groupRefs.current, "mac1", element)
      Reflect.set(controller.groupRefs.current, "mac2", element)
    },
  })
}

const bot = (id: string, machineId: string): BotSummary => ({
  id,
  name: id,
  description: "",
  image: null,
  machineId,
  runtime: "claude",
  modelName: null,
  lastRefreshContextAt: null,
  dailyActivity: [],
})

describe("useBotListController", () => {
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.hookOrder.length = 0
    mocks.target = "mac1"
    mocks.audit = null
    mocks.bots = [bot("b1", "mac1")]
    mocks.botsDataReady = true
    mocks.machines = [
      { id: "mac1", displayName: "One", hostname: "one", status: "online" },
      { id: "mac2", displayName: "Two", hostname: "two", status: "online" },
    ]
    mocks.online = new Set()
    mocks.onboardingSnapshot = null
    mocks.actionState = null
    mocks.createDm.mockResolvedValue({ conversation: { id: "dm1" } })
    mocks.del.mockResolvedValue(undefined)
    mocks.resetBot.mockResolvedValue({ ok: true })
    mocks.resetMachine.mockResolvedValue({ dispatched: 2 })
    scrollIntoView.mockReset()
  })

  afterEach(() => vi.useRealTimers())

  const render = () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe), {
        createNodeMock: () => ({ scrollIntoView }),
      })
    })
    return renderer
  }

  it("keeps the exact external hook order and source-owned thirteen states", () => {
    render()
    expect(mocks.hookOrder.slice(0, 9)).toEqual([
      "router",
      "searchParams",
      "bots",
      "machines",
      "profiles",
      "delete",
      "resetBot",
      "resetMachine",
      "dm",
    ])
    expect(mocks.hookOrder[9]).toBe("onboarding")

    const source = readWebSource("src/components/community/bots/bot-list-controller.ts")
    expect(source.match(/useState(?:<[^\n]+>)?\(/g)).toHaveLength(13)
    expect(source).not.toMatch(/useCallback\(/)
    expect(source.match(/useMemo\(/g)).toHaveLength(1)
    const orderedHooks = [
      "const router = useRouter()",
      "const searchParams = useSearchParams()",
      "const botsQuery = useBots()",
      "const { machines, isLoading: machinesLoading } = useMachines()",
      "const profilesByUserId = useProfilesByUserId()",
      "const [createOpen",
      "const [editingBot",
      "const [editOpen",
      "const [activityBot",
      "const [activityOpen",
      "const [bugReportBot",
      "const [bugReportOpen",
      "const [confirmDelete",
      "const [confirmReset",
      "const [confirmResetMachine",
      "const [collapsedMachines",
      "const [helpOpen",
      "const del = useDeleteBot()",
      "const resetSession = useResetBotSession()",
      "const resetMachineAgents = useResetMachineAgents()",
      "const createOrGetDm = useCreateOrGetDm()",
      "const onboardingState = useCommunityOnboarding()",
      "const groups = useMemo",
      "const [highlightId",
      "const groupRefs = useRef",
      "const scrolledForRef = useRef",
      "useEffect(() =>",
    ]
    const positions = orderedHooks.map((needle) => source.indexOf(needle))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(source).toContain("}, [targetMachineId, bots.length])")

    for (const path of [
      "src/components/community/bots/bot-list-view.tsx",
      "src/components/community/bots/bot-list-machine-group.tsx",
      "src/components/community/bots/bot-list-overlays.tsx",
    ]) {
      expect(readWebSource(path)).not.toMatch(/\buse[A-Z]\w*\(/)
    }
  })

  it("retains non-URL state and both ref-backed lifecycles across loading/data rerenders", () => {
    mocks.target = null
    const renderer = render()
    const refs = latest.groupRefs
    const selected = bot("selected", "mac1")
    const collapsed = new Set(["mac2"])
    act(() => {
      latest.setCreateOpen(true)
      latest.setEditingBot(selected)
      latest.setEditOpen(true)
      latest.setBugReportBot({ id: selected.id, name: selected.name })
      latest.setBugReportOpen(true)
      latest.setConfirmDelete(selected)
      latest.setConfirmReset(selected)
      latest.setConfirmResetMachine("mac2")
      latest.setCollapsedMachines(collapsed)
      latest.setHelpOpen(true)
    })
    mocks.botsLoading = true
    mocks.machinesLoading = true
    mocks.bots = [bot("replacement", "mac2")]
    act(() => renderer.update(React.createElement(Probe)))
    expect(latest.groupRefs).toBe(refs)
    expect(latest.createOpen).toBe(true)
    expect(latest.editingBot).toBe(selected)
    expect(latest.editOpen).toBe(true)
    expect(latest.activityBot).toBeNull()
    expect(latest.activityOpen).toBe(false)
    expect(latest.bugReportBot).toEqual({ id: "selected", name: "selected" })
    expect(latest.bugReportOpen).toBe(true)
    expect(latest.confirmDelete).toBe(selected)
    expect(latest.confirmReset).toBe(selected)
    expect(latest.confirmResetMachine).toBe("mac2")
    expect(latest.collapsedMachines).toBe(collapsed)
    expect(latest.helpOpen).toBe(true)
  })

  it("groups known machines first and unresolved machines last without dropping bots", () => {
    mocks.bots = [bot("unknown-a", "gone"), bot("known-2", "mac2"), bot("known-1", "mac1"), bot("unknown-b", "lost")]
    mocks.target = null
    render()
    expect(latest.groups.map((group) => group.machineId)).toEqual(["mac1", "mac2", "gone", "lost"])
    expect(latest.groups.flatMap((group) => group.bots.map((item) => item.id))).toEqual([
      "known-1",
      "known-2",
      "unknown-a",
      "unknown-b",
    ])
    expect(latest.machineName("gone")).toBe("Unknown machine")
  })

  it("does nothing without a target or without bots", () => {
    mocks.target = null
    render()
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(latest.highlightId).toBeNull()
    expect(vi.getTimerCount()).toBe(0)

    mocks.target = "mac1"
    mocks.bots = []
    render()
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(latest.highlightId).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("opens an owned audit deep link only after its bot is available", () => {
    mocks.audit = "b1"
    mocks.botsDataReady = false
    mocks.botsLoading = true
    const renderer = render()
    expect(latest.activityOpen).toBe(false)
    expect(latest.activityBot).toBeNull()

    mocks.botsLoading = false
    mocks.botsDataReady = true
    act(() => renderer.update(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(true)
    expect(latest.activityBot?.id).toBe("b1")
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("does not consume a reload deep link during a transient idle query without data", () => {
    mocks.audit = "b1"
    mocks.bots = []
    mocks.botsLoading = false
    mocks.botsDataReady = false
    const renderer = render()
    expect(latest.activityOpen).toBe(false)
    expect(mocks.replace).not.toHaveBeenCalled()

    mocks.bots = [bot("b1", "mac1")]
    mocks.botsDataReady = true
    act(() => renderer.update(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(true)
    expect(latest.activityBot?.id).toBe("b1")
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("clears invalid or nonowned audit ids without opening the modal", () => {
    mocks.audit = "foreign"
    render()
    expect(latest.activityOpen).toBe(false)
    expect(latest.activityBot).toBeNull()
    expect(mocks.replace).toHaveBeenCalledWith("/c/me/bots?machineId=mac1")
  })

  it("pushes URL-owned activity state, preserves machineId, and closes with replace", () => {
    const renderer = render()
    act(() => latest.openActivity(mocks.bots[0]!))
    expect(mocks.push).toHaveBeenCalledWith("/c/me/bots?machineId=mac1&audit=b1")

    mocks.audit = "b1"
    act(() => renderer.update(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(true)
    expect(latest.activityBot?.id).toBe("b1")

    act(() => latest.onActivityOpenChange(false))
    expect(latest.activityOpen).toBe(false)
    expect(latest.activityBot).toBeNull()
    expect(mocks.replace).toHaveBeenLastCalledWith("/c/me/bots?machineId=mac1")
  })

  it("closes on Back and reopens the same owned target on Forward", () => {
    mocks.audit = "b1"
    const renderer = render()
    expect(latest.activityOpen).toBe(true)

    mocks.audit = null
    act(() => renderer.update(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(false)
    expect(latest.activityBot).toBeNull()

    mocks.audit = "b1"
    act(() => renderer.update(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(true)
    expect(latest.activityBot?.id).toBe("b1")
  })

  it("clears a normally consumed target after exactly 2000ms", () => {
    render()
    expect(latest.highlightId).toBe("mac1")
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(1999))
    expect(latest.highlightId).toBe("mac1")
    act(() => vi.advanceTimersByTime(1))
    expect(latest.highlightId).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("replaces A with B, cancels A's timer, and cleans the active timer on unmount", () => {
    const renderer = render()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    mocks.target = "mac2"
    act(() => renderer.update(React.createElement(Probe)))
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect(latest.highlightId).toBe("mac2")
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(1999))
    expect(latest.highlightId).toBe("mac2")
    act(() => renderer.unmount())
    expect(vi.getTimerCount()).toBe(0)
  })

  it("preserves both consumed-target timer quirks verbatim", () => {
    const renderer = render()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" })
    expect(latest.highlightId).toBe("mac1")

    act(() => latest.setCollapsedMachines(new Set(["mac1"])))
    mocks.bots = [bot("b1", "mac1"), bot("b2", "mac1")]
    act(() => renderer.update(React.createElement(Probe)))
    expect(latest.collapsedMachines.has("mac1")).toBe(false)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(2000))
    expect(latest.highlightId).toBe("mac1")

    mocks.target = null
    act(() => renderer.update(React.createElement(Probe)))
    mocks.target = "mac1"
    act(() => renderer.update(React.createElement(Probe)))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(2000))
    expect(latest.highlightId).toBe("mac1")
  })

  it("derives all three labels from the render snapshot while actions reread current state", () => {
    mocks.target = null
    const renderer = render()
    expect(latest.guidedCreateLabel).toBe("Create a bot")

    mocks.onboardingSnapshot = {
      status: "active",
      stage: "bot",
      botId: "pending",
      guideAvatarSeed: "seed",
    }
    mocks.actionState = null
    act(() => renderer.update(React.createElement(Probe)))
    expect(latest.guidedCreateLabel).toBe("Open bot chat")
    expect(latest.guidedAvatarSeed).toBe("seed")
    act(() => latest.openGuidedCreate())
    expect(latest.createOpen).toBe(true)
    expect(mocks.createDm).not.toHaveBeenCalled()

    mocks.machines = [{ id: "mac1", displayName: "One", status: "offline" }]
    act(() => renderer.update(React.createElement(Probe)))
    expect(latest.guidedCreateLabel).toBe("Connect a machine")

    mocks.onboardingSnapshot = { status: "active", stage: "bot" }
    mocks.machines = [{ id: "mac1", displayName: "One", status: "online" }]
    act(() => renderer.update(React.createElement(Probe)))
    expect(latest.guidedCreateLabel).toBe("Create a bot")
  })

  it("fires the pending-bot DM without awaiting and advances only after it resolves", async () => {
    mocks.target = null
    mocks.onboardingSnapshot = { status: "active", stage: "bot", botId: "pending" }
    mocks.actionState = { status: "active", stage: "bot", botId: "pending" }
    let resolveDm!: (value: { conversation: { id: string } }) => void
    mocks.createDm.mockReturnValue(new Promise((resolve) => { resolveDm = resolve }))
    render()
    let result: void
    act(() => { result = latest.openGuidedCreate() })
    expect(result!).toBeUndefined()
    expect(mocks.createDm).toHaveBeenCalledWith({ userId: "pending" })
    expect(latest.createOpen).toBe(false)
    expect(mocks.advance).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
    await act(async () => {
      resolveDm({ conversation: { id: "dm1" } })
      await Promise.resolve()
    })
    expect(mocks.advance).toHaveBeenCalledWith("bot", "dm", { botId: "pending", dmId: "dm1" })
    expect(mocks.push).toHaveBeenCalledWith("/c/me/dm1")
  })

  it("recovers a missing machine without opening DM or create", () => {
    mocks.target = null
    mocks.machines = [{ id: "mac1", displayName: "One", status: "offline" }]
    mocks.actionState = { status: "active", stage: "bot", botId: "pending" }
    render()
    expect(latest.openGuidedCreate()).toBeUndefined()
    expect(mocks.recoverMachine).toHaveBeenCalledOnce()
    expect(mocks.push).toHaveBeenCalledWith("/c/me/machines")
    expect(mocks.createDm).not.toHaveBeenCalled()
    expect(latest.createOpen).toBe(false)
  })

  it("opens normal chat on success and reports exact failure without navigation", async () => {
    mocks.target = null
    render()
    await act(async () => { await latest.chatWithBot(bot("chat", "mac1")) })
    expect(mocks.createDm).toHaveBeenCalledWith({ userId: "chat" })
    expect(mocks.push).toHaveBeenCalledWith("/c/me/dm1")

    vi.clearAllMocks()
    const error = new Error("no chat")
    mocks.createDm.mockRejectedValue(error)
    await act(async () => { await latest.chatWithBot(bot("chat", "mac1")) })
    expect(mocks.toastApiError).toHaveBeenCalledWith(error, "Failed to open chat")
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it("makes onBotCreated a no-op for inactive or wrong-stage action-time state", async () => {
    mocks.target = null
    render()
    for (const state of [null, { status: "active", stage: "dm" }]) {
      vi.clearAllMocks()
      mocks.actionState = state
      await act(async () => { await latest.onBotCreated(bot("ignored", "mac1")) })
      expect(mocks.updateResources).not.toHaveBeenCalled()
      expect(mocks.createDm).not.toHaveBeenCalled()
      expect(mocks.advance).not.toHaveBeenCalled()
      expect(mocks.push).not.toHaveBeenCalled()
    }
  })

  it("updates a created bot before awaiting DM and advances/pushes only on success", async () => {
    mocks.target = null
    mocks.actionState = { status: "active", stage: "bot" }
    let resolveDm!: (value: { conversation: { id: string } }) => void
    mocks.createDm.mockReturnValue(new Promise((resolve) => { resolveDm = resolve }))
    render()

    let completion!: Promise<void>
    act(() => { completion = latest.onBotCreated(bot("new", "mac1")) })
    expect(mocks.updateResources).toHaveBeenCalledWith({ botId: "new" })
    expect(mocks.updateResources.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createDm.mock.invocationCallOrder[0]!)
    expect(mocks.advance).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
    await act(async () => {
      resolveDm({ conversation: { id: "dm-new" } })
      await completion
    })
    expect(mocks.advance).toHaveBeenCalledWith("bot", "dm", { botId: "new", dmId: "dm-new" })
    expect(mocks.createDm.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.advance.mock.invocationCallOrder[0]!)
    expect(mocks.advance.mock.invocationCallOrder[0]).toBeLessThan(mocks.push.mock.invocationCallOrder[0])

    vi.clearAllMocks()
    mocks.createDm.mockRejectedValue(new Error("no dm"))
    await act(async () => { await latest.onBotCreated(bot("failed", "mac1")) })
    expect(mocks.updateResources).toHaveBeenCalledWith({ botId: "failed" })
    expect(mocks.toastApiError).toHaveBeenCalledWith(
      expect.any(Error),
      "Bot created, but the chat couldn't open",
    )
    expect(mocks.advance).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it("does not dispatch or toast when confirm selections are absent", async () => {
    mocks.target = null
    render()
    await act(async () => {
      await latest.deleteConfirmedBot()
      await latest.resetConfirmedBot()
      await latest.resetConfirmedMachine()
    })
    expect(mocks.del).not.toHaveBeenCalled()
    expect(mocks.resetBot).not.toHaveBeenCalled()
    expect(mocks.resetMachine).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.toastApiError).not.toHaveBeenCalled()
    expect(latest.confirmDelete).toBeNull()
    expect(latest.confirmReset).toBeNull()
    expect(latest.confirmResetMachine).toBeNull()
  })

  it("preserves delete success, generic rejection, and finally clearing", async () => {
    mocks.target = null
    render()
    act(() => latest.setConfirmDelete(bot("delete-me", "mac1")))
    await act(async () => { await latest.deleteConfirmedBot() })
    expect(mocks.del).toHaveBeenCalledWith("delete-me")
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Deleted delete-me")
    expect(latest.confirmDelete).toBeNull()

    vi.clearAllMocks()
    const error = new Error("delete failed")
    mocks.del.mockRejectedValueOnce(error)
    act(() => latest.setConfirmDelete(bot("reject-me", "mac1")))
    await act(async () => { await latest.deleteConfirmedBot() })
    expect(mocks.toastApiError).toHaveBeenCalledWith(error, "Couldn't delete the bot")
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(latest.confirmDelete).toBeNull()
  })

  it("covers reset-bot success, generic errors, the offline conjunction, and finally", async () => {
    mocks.target = null
    render()
    const select = () => act(() => latest.setConfirmReset(bot("reset-me", "mac1")))

    select()
    await act(async () => { await latest.resetConfirmedBot() })
    expect(mocks.resetBot).toHaveBeenCalledWith("reset-me")
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Session reset.")
    expect(latest.confirmReset).toBeNull()

    for (const error of [
      new Error("generic"),
      { status: 409, message: "runner unavailable" },
      { status: 500, message: "runner offline" },
    ]) {
      vi.clearAllMocks()
      mocks.resetBot.mockRejectedValueOnce(error)
      select()
      await act(async () => { await latest.resetConfirmedBot() })
      expect(mocks.toastApiError).toHaveBeenCalledWith(error, "Couldn't reset the bot's session")
      expect(mocks.toastError).not.toHaveBeenCalled()
      expect(latest.confirmReset).toBeNull()
    }

    vi.clearAllMocks()
    mocks.resetBot.mockRejectedValueOnce({ status: 409, message: "runner OFFLINE" })
    select()
    await act(async () => { await latest.resetConfirmedBot() })
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Bot is offline — bring it online before resetting.",
    )
    expect(mocks.toastApiError).not.toHaveBeenCalled()
    expect(latest.confirmReset).toBeNull()
  })

  it("covers reset-machine payload/name, grammar, errors, offline, and finally", async () => {
    mocks.target = null
    render()
    const select = () => act(() => latest.setConfirmResetMachine("mac1"))

    mocks.resetMachine.mockResolvedValueOnce({ dispatched: 1 })
    select()
    await act(async () => { await latest.resetConfirmedMachine() })
    expect(mocks.resetMachine).toHaveBeenCalledWith("mac1")
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Dispatched reset to 1 agent on One.")
    expect(latest.confirmResetMachine).toBeNull()

    vi.clearAllMocks()
    mocks.resetMachine.mockResolvedValueOnce({ dispatched: 3 })
    select()
    await act(async () => { await latest.resetConfirmedMachine() })
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Dispatched reset to 3 agents on One.")
    expect(latest.confirmResetMachine).toBeNull()

    for (const generic of [
      { status: 409, message: "runner unavailable" },
      { status: 500, message: "machine offline" },
    ]) {
      vi.clearAllMocks()
      mocks.resetMachine.mockRejectedValueOnce(generic)
      select()
      await act(async () => { await latest.resetConfirmedMachine() })
      expect(mocks.toastApiError).toHaveBeenCalledWith(
        generic,
        "Couldn't reset the machine's agents",
      )
      expect(mocks.toastError).not.toHaveBeenCalled()
      expect(latest.confirmResetMachine).toBeNull()
    }

    vi.clearAllMocks()
    mocks.resetMachine.mockRejectedValueOnce({ status: 409, message: "machine OFFLINE" })
    select()
    await act(async () => { await latest.resetConfirmedMachine() })
    expect(mocks.toastError).toHaveBeenCalledWith(
      "One is offline — bring it online before resetting.",
    )
    expect(mocks.toastApiError).not.toHaveBeenCalled()
    expect(latest.confirmResetMachine).toBeNull()
  })
})
