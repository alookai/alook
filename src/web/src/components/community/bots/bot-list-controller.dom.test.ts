import React from "react"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { act, render as rtlRender } from "@/test/react-dom-harness"
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
  isFounder: true,
  billingReturn: null as string | null,
  planSummary: {
    plan: { id: "free", displayName: "Free" },
    limit: 3,
    ownedCount: 1,
    activeCount: 1,
  },
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
  setActive: vi.fn(),
  advance: vi.fn(),
  updateResources: vi.fn(),
  recoverMachine: vi.fn(),
  onProbeLayout: null as null | ((controller: BotListController) => void),
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
      get: (key: string) => key === "machineId" ? mocks.target : key === "audit" ? mocks.audit : mocks.billingReturn,
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
      data: mocks.botsDataReady ? { bots: mocks.bots, ...mocks.planSummary, isFounder: mocks.isFounder } : undefined,
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
  useSetBotActive: () => {
    mocks.hookOrder.push("setActive")
    return { mutateAsync: mocks.setActive }
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

vi.mock("@/hooks/community/use-billing", () => ({
  readBillingReturn: (value: string | null) => ["checkout", "cancel", "portal"].includes(value ?? "") ? value : null,
  useBilling: () => ({ data: undefined, isPending: true, refresh: vi.fn() }),
}))

import { useBotListController } from "./bot-list-controller"

let latest: BotListController
const scrollIntoView = vi.fn()
function Probe() {
  const controller = useBotListController()
  React.useLayoutEffect(() => {
    latest = controller
    mocks.onProbeLayout?.(controller)
  }, [controller])
  return React.createElement("div", {
    ref: (element: HTMLDivElement | null) => {
      if (element) element.scrollIntoView = scrollIntoView
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
  isActive: true,
  lastRefreshContextAt: null,
  dailyActivity: [],
})

describe("useBotListController", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.isFounder = true
    mocks.billingReturn = null
    mocks.hookOrder.length = 0
    mocks.target = "mac1"
    mocks.audit = null
    mocks.bots = [bot("b1", "mac1")]
    mocks.botsDataReady = true
    mocks.planSummary = {
      plan: { id: "free", displayName: "Free" },
      limit: 3,
      ownedCount: 1,
      activeCount: 1,
    }
    mocks.machines = [
      { id: "mac1", displayName: "One", hostname: "one", status: "online" },
      { id: "mac2", displayName: "Two", hostname: "two", status: "online" },
    ]
    mocks.online = new Set()
    mocks.onboardingSnapshot = null
    mocks.actionState = null
    mocks.onProbeLayout = null
    mocks.createDm.mockResolvedValue({ conversation: { id: "dm1" } })
    mocks.del.mockResolvedValue(undefined)
    mocks.resetBot.mockResolvedValue({ ok: true })
    mocks.resetMachine.mockResolvedValue({ dispatched: 2 })
    mocks.setActive.mockResolvedValue({ bot: { id: "b1", isActive: false }, changed: true })
    scrollIntoView.mockReset()
  })

  afterEach(() => vi.useRealTimers())

  const render = () => {
    let renderer!: ReturnType<typeof rtlRender>
    act(() => {
      renderer = rtlRender(React.createElement(Probe))
    })
    return renderer
  }

  it("keeps the exact external hook order and source-owned states", () => {
    render()
    expect(mocks.hookOrder.slice(0, 10)).toEqual([
      "router",
      "searchParams",
      "bots",
      "machines",
      "profiles",
      "delete",
      "resetBot",
      "resetMachine",
      "setActive",
      "dm",
    ])
    expect(mocks.hookOrder[10]).toBe("onboarding")

    const source = readWebSource("src/components/community/bots/bot-list-controller.ts")
    expect(source.match(/useState(?:<[^\n]+>)?\(/g)).toHaveLength(16)
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
      "const [activityGeneration",
      "const [bugReportBot",
      "const [bugReportOpen",
      "const [confirmDelete",
      "const [confirmReset",
      "const [confirmResetMachine",
      "const [collapsedMachines",
      "const [helpOpen",
      "const [pendingActiveBotIds",
      "const del = useDeleteBot()",
      "const resetSession = useResetBotSession()",
      "const resetMachineAgents = useResetMachineAgents()",
      "const setActive = useSetBotActive()",
      "const createOrGetDm = useCreateOrGetDm()",
      "const onboardingState = useCommunityOnboarding()",
      "const groups = useMemo",
      "const [highlightId",
      "const groupRefs = useRef",
      "const scrolledForRef = useRef",
      "useEffect(() => {\n    if (!targetMachineId",
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
    act(() => renderer.rerender(React.createElement(Probe)))
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

  it("projects plan inventory and blocks create at owned capacity with recovery copy", () => {
    mocks.target = null
    mocks.planSummary = {
      plan: { id: "free", displayName: "Free" },
      limit: 3,
      ownedCount: 3,
      activeCount: 2,
    }
    render()
    expect(latest.planSummary).toEqual({ ...mocks.planSummary, isFounder: mocks.isFounder })
    expect(latest.isCreateDisabled).toBe(true)
    act(() => latest.openGuidedCreate())
    expect(latest.createOpen).toBe(false)
    expect(latest.billingOpen).toBe(true)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each([
    { isFounder: false, ownedCount: 3 },
    { isFounder: false, ownedCount: 4 },
    { isFounder: true, ownedCount: 3 },
    { isFounder: true, ownedCount: 4 },
  ])("opens capacity recovery for owned=$ownedCount and Founder=$isFounder", ({ isFounder, ownedCount }) => {
    mocks.target = null
    mocks.isFounder = isFounder
    mocks.planSummary = { ...mocks.planSummary, ownedCount, limit: 3 }
    render()
    expect(latest.canShowLimit).toBe(true)
    act(() => latest.openGuidedCreate())
    expect(latest.billingOpen).toBe(true)
    expect(latest.createOpen).toBe(false)
  })

  it.each([false, true])("does not infer capacity without an exhausted loaded plan (loaded=%s)", (loaded) => {
    mocks.target = null
    mocks.botsDataReady = loaded
    mocks.planSummary = { ...mocks.planSummary, ownedCount: 2, limit: 3 }
    render()
    expect(latest.canShowLimit).toBe(loaded)
    expect(latest.isCreateDisabled).toBe(false)
    act(() => latest.openGuidedCreate())
    expect(latest.createOpen).toBe(true)
    expect(latest.billingOpen).toBe(false)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it("leaves billing returns to settings and opens the unified plan destination", () => {
    mocks.billingReturn = "checkout"
    window.history.replaceState(null, "", "/c/me/bots?billing=checkout&audit=bot1#details")
    render()
    expect(latest.billingOpen).toBe(false)
    act(() => latest.viewPlan())
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/c/me/bots?audit=bot1&settings=billing#details")
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it("disables only the toggled bot, suppresses double clicks, and clears pending on success", async () => {
    mocks.target = null
    let resolveActive!: (value: { bot: { id: string; isActive: boolean }; changed: boolean }) => void
    mocks.setActive.mockReturnValue(new Promise((resolve) => { resolveActive = resolve }))
    render()
    let completion!: Promise<void>
    act(() => { completion = latest.setBotActive(mocks.bots[0]!, false) })
    expect(latest.pendingActiveBotIds).toEqual(new Set(["b1"]))
    await act(async () => { await latest.setBotActive(mocks.bots[0]!, false) })
    expect(mocks.setActive).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveActive({ bot: { id: "b1", isActive: false }, changed: true })
      await completion
    })
    expect(latest.pendingActiveBotIds).toEqual(new Set())
    expect(mocks.toastSuccess).toHaveBeenCalledWith("b1 is now Inactive")
  })

  it("keeps the prior state and gives an actionable capacity recovery on toggle failure", async () => {
    mocks.target = null
    mocks.setActive.mockRejectedValue({ status: 409, message: "BOT_ACTIVE_LIMIT_REACHED" })
    render()
    await act(async () => { await latest.setBotActive(mocks.bots[0]!, false) })
    expect(latest.bots[0]?.isActive).toBe(true)
    expect(latest.pendingActiveBotIds).toEqual(new Set())
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Plan limit reached — make another bot inactive or change plan.",
    )
    expect(mocks.toastApiError).not.toHaveBeenCalled()
  })

  it("reports a generic activation failure through the shared API error path", async () => {
    mocks.target = null
    const error = new Error("activation failed")
    mocks.setActive.mockRejectedValue(error)
    render()

    await act(async () => { await latest.setBotActive(mocks.bots[0]!, false) })

    expect(mocks.toastApiError).toHaveBeenCalledWith(error, "Couldn't make b1 inactive")
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(latest.pendingActiveBotIds).toEqual(new Set())
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
    act(() => renderer.rerender(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(true)
    expect(latest.activityBot?.id).toBe("b1")
    expect(latest.activityGeneration).toBe(1)
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
    act(() => renderer.rerender(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(true)
    expect(latest.activityBot?.id).toBe("b1")
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("clears invalid or nonowned audit ids without opening the modal", () => {
    mocks.audit = "foreign"
    render()
    expect(latest.activityOpen).toBe(false)
    expect(latest.activityBot).toBeNull()
    expect(latest.activityGeneration).toBe(0)
    expect(mocks.replace).toHaveBeenCalledWith("/c/me/bots?machineId=mac1")
  })

  it("preserves URL state and retains the closing snapshot until eligible completion", () => {
    const renderer = render()
    act(() => latest.openActivity(mocks.bots[0]!))
    expect(mocks.push).toHaveBeenCalledWith("/c/me/bots?machineId=mac1&audit=b1")

    mocks.audit = "b1"
    act(() => renderer.rerender(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(true)
    expect(latest.activityBot?.id).toBe("b1")
    const generation = latest.activityGeneration

    act(() => latest.onActivityOpenChange(false))
    expect(latest.activityOpen).toBe(false)
    expect(latest.activityBot?.id).toBe("b1")
    expect(mocks.replace).toHaveBeenLastCalledWith("/c/me/bots?machineId=mac1")

    act(() => latest.onActivityOpenChangeComplete(true, generation))
    expect(latest.activityBot?.id).toBe("b1")
    act(() => latest.onActivityOpenChangeComplete(false, generation + 1))
    expect(latest.activityBot?.id).toBe("b1")
    act(() => latest.onActivityOpenChangeComplete(false, generation))
    expect(latest.activityBot).toBeNull()
    act(() => latest.onActivityOpenChangeComplete(false, generation))
    expect(latest.activityBot).toBeNull()
  })

  it("retains on Back and fences the old completion after Forward", () => {
    mocks.audit = "b1"
    const renderer = render()
    expect(latest.activityOpen).toBe(true)
    const closingGeneration = latest.activityGeneration

    mocks.audit = null
    act(() => renderer.rerender(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(false)
    expect(latest.activityBot?.id).toBe("b1")

    mocks.audit = "b1"
    act(() => renderer.rerender(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(true)
    expect(latest.activityBot?.id).toBe("b1")
    expect(latest.activityGeneration).toBe(closingGeneration + 1)
    const reopenedGeneration = latest.activityGeneration

    act(() => latest.onActivityOpenChangeComplete(false, closingGeneration))
    expect(latest.activityOpen).toBe(true)
    expect(latest.activityBot?.id).toBe("b1")
    act(() => latest.onActivityOpenChangeComplete(false, reopenedGeneration))
    expect(latest.activityOpen).toBe(true)
    expect(latest.activityBot?.id).toBe("b1")
  })

  it("advances generation for a same-bot reopen after explicit close", () => {
    mocks.audit = "b1"
    const renderer = render()
    const closingGeneration = latest.activityGeneration

    act(() => latest.onActivityOpenChange(false))
    expect(latest.activityOpen).toBe(false)
    expect(latest.activityBot?.id).toBe("b1")
    mocks.audit = null
    act(() => renderer.rerender(React.createElement(Probe)))

    act(() => latest.openActivity(mocks.bots[0]!))
    mocks.audit = "b1"
    act(() => renderer.rerender(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(true)
    expect(latest.activityGeneration).toBe(closingGeneration + 1)

    act(() => latest.onActivityOpenChangeComplete(false, closingGeneration))
    expect(latest.activityBot?.id).toBe("b1")
  })

  it("lets B replace a closing A and ignores A's completion", () => {
    mocks.audit = "b1"
    mocks.bots = [bot("b1", "mac1"), bot("b2", "mac1")]
    const renderer = render()
    const aGeneration = latest.activityGeneration

    act(() => latest.onActivityOpenChange(false))
    expect(latest.activityOpen).toBe(false)
    expect(latest.activityBot?.id).toBe("b1")

    act(() => latest.openActivity(mocks.bots[1]!))
    mocks.audit = "b2"
    act(() => renderer.rerender(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(true)
    expect(latest.activityBot?.id).toBe("b2")
    expect(latest.activityGeneration).toBe(aGeneration + 1)

    act(() => latest.onActivityOpenChangeComplete(false, aGeneration))
    expect(latest.activityBot?.id).toBe("b2")
  })

  it("keeps a new valid target when close completion races before its open effect", () => {
    mocks.audit = "b1"
    mocks.bots = [bot("b1", "mac1"), bot("b2", "mac1")]
    const renderer = render()
    const aGeneration = latest.activityGeneration

    act(() => latest.onActivityOpenChange(false))
    mocks.onProbeLayout = (controller) => {
      if (controller.activityOpen) return
      controller.onActivityOpenChangeComplete(false, aGeneration)
    }
    mocks.audit = "b2"
    act(() => renderer.rerender(React.createElement(Probe)))

    expect(latest.activityOpen).toBe(true)
    expect(latest.activityBot?.id).toBe("b2")
    expect(latest.activityGeneration).toBe(aGeneration + 1)
  })

  it("retains a disappeared target and lets a new valid target beat its completion", () => {
    mocks.audit = "b1"
    mocks.bots = [bot("b1", "mac1"), bot("b2", "mac1")]
    const renderer = render()
    const aGeneration = latest.activityGeneration

    mocks.bots = [bot("b2", "mac1")]
    act(() => renderer.rerender(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(false)
    expect(latest.activityBot?.id).toBe("b1")
    expect(mocks.replace).toHaveBeenLastCalledWith("/c/me/bots?machineId=mac1")

    mocks.audit = "b2"
    act(() => renderer.rerender(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(true)
    expect(latest.activityBot?.id).toBe("b2")
    expect(latest.activityGeneration).toBe(aGeneration + 1)

    act(() => latest.onActivityOpenChangeComplete(false, aGeneration))
    expect(latest.activityBot?.id).toBe("b2")
  })

  it("clears a disappeared target only after its matching false completion", () => {
    mocks.audit = "b1"
    const renderer = render()
    const generation = latest.activityGeneration

    mocks.bots = []
    act(() => renderer.rerender(React.createElement(Probe)))
    expect(latest.activityOpen).toBe(false)
    expect(latest.activityBot?.id).toBe("b1")

    act(() => latest.onActivityOpenChangeComplete(false, generation))
    expect(latest.activityBot).toBeNull()
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
    act(() => renderer.rerender(React.createElement(Probe)))
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
    act(() => renderer.rerender(React.createElement(Probe)))
    expect(latest.collapsedMachines.has("mac1")).toBe(false)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(2000))
    expect(latest.highlightId).toBe("mac1")

    mocks.target = null
    act(() => renderer.rerender(React.createElement(Probe)))
    mocks.target = "mac1"
    act(() => renderer.rerender(React.createElement(Probe)))
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
    act(() => renderer.rerender(React.createElement(Probe)))
    expect(latest.guidedCreateLabel).toBe("Open bot chat")
    expect(latest.guidedAvatarSeed).toBe("seed")
    act(() => latest.openGuidedCreate())
    expect(latest.createOpen).toBe(true)
    expect(mocks.createDm).not.toHaveBeenCalled()

    mocks.machines = [{ id: "mac1", displayName: "One", status: "offline" }]
    act(() => renderer.rerender(React.createElement(Probe)))
    expect(latest.guidedCreateLabel).toBe("Connect a machine")

    mocks.onboardingSnapshot = { status: "active", stage: "bot" }
    mocks.machines = [{ id: "mac1", displayName: "One", status: "online" }]
    act(() => renderer.rerender(React.createElement(Probe)))
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
