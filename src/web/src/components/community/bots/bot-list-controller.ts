"use client"
import { useObservedRegion } from "@/lib/observability/regions"
import { mergeEvidence, viewEvidence } from "@/lib/observability/data-source"
import { useCommunityRuntime } from "@/stores/community/runtime"

import { createStore, useSelector, useAtom, useCreateAtom } from "@tanstack/react-store";
import { useMutationState, useQueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { isPresenceOnline } from "@alook/shared"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { removeCommunityParam } from "@/lib/community/community-route"
import { machineName as resolveMachineName } from "@/lib/community/machine-name"
import { useMachines } from "@/hooks/community/use-machines"
import {
  useBots,
  useDeleteBot,
  useResetBotSession,
  useResetMachineAgents,
  useSetBotActive,
  type BotSummary,
  type BotsResourceResponse,
} from "@/hooks/community/use-bots"
import { useCreateOrGetDm } from "@/hooks/community/mutations"
import { useUiHandlers } from "@/stores/community"
import { useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
import {
  advanceCommunityOnboarding,
  readCommunityOnboardingState,
  recoverCommunityOnboardingMachine,
  updateCommunityOnboardingResources,
  useCommunityOnboarding,
} from "@/lib/community-onboarding"
import type { BotListController } from "./bot-list-types"

export function useBotListController(): BotListController {
  const communityRuntime = useCommunityRuntime()
  const client = useQueryClient()
  const protocol = useMemo(() => createStore({ scrolledFor: null as string | null, suppressedAudit: null as string | null, targetAudit: null as string | null, activityOpen: false, activityGeneration: 0 }), [])
  const patchProtocol = useCallback((patch: Partial<ReturnType<typeof protocol.get>>) => protocol.setState((state) => ({ ...state, ...patch })), [protocol])
  const router = useRouter()
  const source = useCommunityViewSource("bot-list")
  const uiHandlers = useUiHandlers()
  const searchParams = useSearchParams()
  const botsQuery = useBots()
  const { bots, isLoading } = botsQuery
  const botsResolved = botsQuery.data !== undefined
  const [billingOpen, setBillingOpen] = useAtom(useCreateAtom(false))
  const canShowLimit = botsResolved
  const viewPlan = () => {
    const next = new URL(window.location.href)
    next.searchParams.delete("billing")
    next.searchParams.set("settings", "billing")
    window.history.pushState(null, "", `${next.pathname}${next.search}${next.hash}`)
  }
  const { machines, isLoading: machinesLoading } = useMachines()
  useObservedRegion("bots", botsResolved && (!(isLoading || machinesLoading) || bots.length > 0), { ...mergeEvidence([viewEvidence(bots), viewEvidence(machines)]), count: bots.length })
  const profilesByUserId = useCanonicalProfilesByUserId(bots.map((bot) => bot.id))
  const [createOpen, setCreateOpen] = useAtom(useCreateAtom(false))
  const [editingBotId, setEditingBotId] = useAtom(useCreateAtom<string | null>(null))
  const editingBot = bots.find((bot) => bot.id === editingBotId) ?? null
  const setEditingBot = (bot: BotSummary | null) => setEditingBotId(bot?.id ?? null)
  const [editOpen, setEditOpen] = useAtom(useCreateAtom(false))
  const [activityBotId, setActivityBotId] = useAtom(useCreateAtom<string | null>(null))
  const activityBot = bots.find((bot) => bot.id === activityBotId) ?? null
  const setActivityBot = useCallback((bot: BotSummary | null) => setActivityBotId(bot?.id ?? null), [setActivityBotId])
  const activityOpen = useSelector(protocol, (state) => state.activityOpen)
  const activityGeneration = useSelector(protocol, (state) => state.activityGeneration)
  const setActivityOpen = useCallback((activityOpen: boolean) => patchProtocol({ activityOpen }), [patchProtocol])
  const setActivityGeneration = useCallback((activityGeneration: number) => patchProtocol({ activityGeneration }), [patchProtocol])
  const [bugReportBotId, setBugReportBotId] = useAtom(useCreateAtom<string | null>(null))
  const bugReportBot = bots.find((bot) => bot.id === bugReportBotId) ?? null
  const setBugReportBot = (bot: Pick<BotSummary, "id" | "name"> | null) => setBugReportBotId(bot?.id ?? null)
  const [bugReportOpen, setBugReportOpen] = useAtom(useCreateAtom(false))
  const [deleteBotId, setDeleteBotId] = useAtom(useCreateAtom<string | null>(null))
  const [resetBotId, setResetBotId] = useAtom(useCreateAtom<string | null>(null))
  const confirmDelete = bots.find((bot) => bot.id === deleteBotId) ?? null
  const confirmReset = bots.find((bot) => bot.id === resetBotId) ?? null
  const setConfirmDelete = (bot: BotSummary | null) => setDeleteBotId(bot?.id ?? null)
  const setConfirmReset = (bot: BotSummary | null) => setResetBotId(bot?.id ?? null)
  const [confirmResetMachine, setConfirmResetMachine] = useAtom(useCreateAtom<string | null>(null))
  const [collapsedMachines, setCollapsedMachines] = useAtom(useCreateAtom<Set<string>>(new Set<string>()))
  const [helpOpen, setHelpOpen] = useAtom(useCreateAtom(false))
  const pendingBotIds = useMutationState({ filters: { mutationKey: [...communityKeys.bots(), "active-command"], status: "pending" }, select: (mutation) => (mutation.state.variables as { input: { id: string } }).input.id })
  const pendingActiveBotIds = useMemo(() => new Set(pendingBotIds), [pendingBotIds])
  const del = useDeleteBot()
  const resetSession = useResetBotSession()
  const resetMachineAgents = useResetMachineAgents()
  const setActive = useSetBotActive()
  const createOrGetDm = useCreateOrGetDm()
  const onboardingState = useCommunityOnboarding()
  const guidedActive = onboardingState?.status === "active" && onboardingState.stage === "bot"
  const guidedPendingBotId = guidedActive ? onboardingState.botId : undefined
  const guidedNeedsMachine =
    guidedActive && !machines.some((machine) => isPresenceOnline(machine.status))
  const guidedCreateLabel = guidedNeedsMachine
    ? "Connect a machine"
    : guidedPendingBotId
      ? "Open bot chat"
      : "Create a bot"
  const planSummary = botsQuery.data
    ? {
        plan: botsQuery.data.plan,
        limit: botsQuery.data.limit,
        ownedCount: botsQuery.data.ownedCount,
        activeCount: botsQuery.data.activeCount,
        isFounder: botsQuery.data.isFounder,
      }
    : null
  const isAtCapacity = Boolean(
    planSummary && planSummary.ownedCount >= planSummary.limit,
  )
  const isCreateDisabled = isAtCapacity && guidedCreateLabel === "Create a bot"

  const chatWithBot = async (bot: BotSummary) => {
    const assert = source.capture()
    assert()
    uiHandlers.cancelPendingNavigation?.()
    try {
      const data = await createOrGetDm.mutateAsync({ userId: bot.id, assertActive: assert })
      assert()
      router.push(`/c/me/${data.conversation.id}`)
    } catch (e) {
      toastApiError(e, "Failed to open chat", assert)
    }
  }

  const openGuidedBotDm = async (botId: string) => {
    const assert = source.capture()
    assert()
    uiHandlers.cancelPendingNavigation?.()
    try {
      const data = await createOrGetDm.mutateAsync({ userId: botId, assertActive: assert })
      assert()
      advanceCommunityOnboarding(communityRuntime, "bot", "dm", {
        botId,
        dmId: data.conversation.id,
      })
      router.push(`/c/me/${data.conversation.id}`)
    } catch (e) {
      toastApiError(e, "Bot created, but the chat couldn't open", assert)
    }
  }

  const onBotCreated = async (bot: BotSummary) => {
    const state = readCommunityOnboardingState(communityRuntime)
    if (state?.status !== "active" || state.stage !== "bot") return
    updateCommunityOnboardingResources(communityRuntime, { botId: bot.id })
    await openGuidedBotDm(bot.id)
  }

  const openGuidedCreate = () => {
    const state = readCommunityOnboardingState(communityRuntime)
    const hasUsableMachine = machines.some((machine) => isPresenceOnline(machine.status))
    if (state?.status === "active" && state.stage === "bot" && !hasUsableMachine) {
      recoverCommunityOnboardingMachine(communityRuntime)
      uiHandlers.cancelPendingNavigation?.()
      router.push("/c/me/machines")
      return
    }
    if (state?.status === "active" && state.stage === "bot" && state.botId) {
      void openGuidedBotDm(state.botId)
      return
    }
    if (isCreateDisabled) {
      setBillingOpen(true)
      return
    }
    setCreateOpen(true)
  }

  const setBotActive = async (bot: BotSummary, active: boolean) => {
    if (pendingActiveBotIds.has(bot.id) || bot.isActive === active || client.getMutationCache().findAll({ mutationKey: [...communityKeys.bots(), "active-command"], status: "pending" }).some((mutation) => (mutation.state.variables as { input: { id: string } }).input.id === bot.id)) return
    const assert = source.capture()
    assert()
    try {
      await setActive.mutateAsync({ id: bot.id, active, assertActive: assert })
      assert()
      toast.success(`${bot.name} is now ${active ? "Active" : "Inactive"}`)
    } catch (error) {
      try { assert() } catch { return }
      const status = (error as { status?: number } | undefined)?.status
      const message = (error as { message?: string } | undefined)?.message ?? ""
      if (status === 409 && message === "BOT_ACTIVE_LIMIT_REACHED") {
        toast.error("Plan limit reached — make another bot inactive or change plan.")
      } else {
        toastApiError(error, `Couldn't make ${bot.name} ${active ? "active" : "inactive"}`)
      }
    }
  }

  const machineName = (id: string): string => {
    const machine = machines.find((item) => item.id === id)
    if (!machine) return "Machine unavailable"
    return resolveMachineName(machine)
  }

  const groups = useMemo(() => {
    const byMachine = new Map<string, BotSummary[]>()
    for (const bot of bots) {
      const list = byMachine.get(bot.machineId)
      if (list) list.push(bot)
      else byMachine.set(bot.machineId, [bot])
    }
    const orderedIds = [
      ...machines.map((machine) => machine.id).filter((id) => byMachine.has(id)),
      ...[...byMachine.keys()].filter((id) => !machines.some((machine) => machine.id === id)),
    ]
    return orderedIds.map((machineId) => ({
      machineId,
      machine: machines.find((machine) => machine.id === machineId) ?? null,
      bots: byMachine.get(machineId)!,
    }))
  }, [bots, machines])

  const targetMachineId = searchParams.get("machineId")
  const targetAuditBotId = searchParams.get("audit")
  const [highlightId, setHighlightId] = useAtom(useCreateAtom<string | null>(null))
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({})
  useLayoutEffect(() => {
    patchProtocol({ targetAudit: targetAuditBotId })
  }, [patchProtocol, protocol, targetAuditBotId])
  useEffect(() => {
    if (!targetMachineId || bots.length === 0) return
    setCollapsedMachines((current) => {
      if (!current.has(targetMachineId)) return current
      const next = new Set(current)
      next.delete(targetMachineId)
      return next
    })
    if (protocol.get().scrolledFor === targetMachineId) return
    const assert = source.capture()
    patchProtocol({ scrolledFor: targetMachineId })
    groupRefs.current[targetMachineId]?.scrollIntoView({ behavior: "smooth", block: "start" })
    setHighlightId(targetMachineId)
    const timer = setTimeout(() => { try { assert(); setHighlightId(null) } catch {} }, 2000)
    return () => clearTimeout(timer)
  }, [targetMachineId, bots.length, setCollapsedMachines, protocol, source, patchProtocol, setHighlightId])

  useEffect(() => {
    if (!botsResolved) return
    if (!targetAuditBotId) {
      patchProtocol({ suppressedAudit: null })
      if (activityOpen) {
        setActivityOpen(false)
      }
      return
    }
    if (protocol.get().suppressedAudit === targetAuditBotId) return

    const targetBot = bots.find((bot) => bot.id === targetAuditBotId)
    if (!targetBot) {
      patchProtocol({ suppressedAudit: targetAuditBotId })
      if (activityOpen) {
        setActivityOpen(false)
      }
      const query = searchParams.toString()
      router.replace(removeCommunityParam(`/c/me/bots${query ? `?${query}` : ""}`, "audit"))
      return
    }

    patchProtocol({ suppressedAudit: null })
    const targetChanged = activityBot?.id !== targetBot.id
    if (!activityOpen || targetChanged) {
      const nextGeneration = protocol.get().activityGeneration + 1
      setActivityGeneration(nextGeneration)
    }
    if (targetChanged) setActivityBot(targetBot)
    if (!activityOpen) {
      setActivityOpen(true)
    }
  }, [activityBot, activityOpen, bots, botsResolved, patchProtocol, protocol, router, searchParams, setActivityBot, setActivityGeneration, setActivityOpen, targetAuditBotId])

  const openActivity = (bot: BotSummary) => {
    uiHandlers.cancelPendingNavigation?.()
    patchProtocol({ suppressedAudit: null })
    const next = new URLSearchParams(searchParams.toString())
    next.set("audit", bot.id)
    router.push(`/c/me/bots?${next.toString()}`)
  }

  const onActivityOpenChange = (open: boolean) => {
    if (open) return
    if (targetAuditBotId) patchProtocol({ suppressedAudit: targetAuditBotId })
    setActivityOpen(false)
    const query = searchParams.toString()
    router.replace(removeCommunityParam(`/c/me/bots${query ? `?${query}` : ""}`, "audit"))
  }

  const onActivityOpenChangeComplete = (open: boolean, generation: number) => {
    try { source.capture()() } catch { return }
    if (open || generation !== protocol.get().activityGeneration || protocol.get().activityOpen) return
    const targetId = protocol.get().targetAudit
    const hasUnsuppressedValidTarget = Boolean(
      targetId &&
      protocol.get().suppressedAudit !== targetId &&
      client.getQueryData<BotsResourceResponse>(communityKeys.bots())?.bots.some((bot) => bot.id === targetId),
    )
    if (hasUnsuppressedValidTarget) return
    setActivityBot(null)
  }

  const openMachines = () => {
    uiHandlers.cancelPendingNavigation?.()
    router.push("/c/me/machines")
  }
  const bringMachineOnline = (machineId: string) => {
    uiHandlers.cancelPendingNavigation?.()
    router.push(`/c/me/machines?reconnect=${machineId}`)
  }

  const deleteConfirmedBot = async () => {
    if (!confirmDelete) return
    const assert = source.capture(), id = confirmDelete.id
    assert()
    const name = confirmDelete.name
    try {
      await del.mutateAsync({ id: confirmDelete.id, assertActive: assert })
      assert()
      toast.success(`Deleted ${name}`)
    } catch (e) {
      toastApiError(e, "Couldn't delete the bot", assert)
    } finally {
      try { assert(); setDeleteBotId((current) => current === id ? null : current) } catch {}
    }
  }

  const resetConfirmedBot = async () => {
    if (!confirmReset) return
    const assert = source.capture(), id = confirmReset.id
    assert()
    try {
      await resetSession.mutateAsync({ id: confirmReset.id, assertActive: assert })
      assert()
      toast.success("Session reset.")
    } catch (e) {
      try { assert() } catch { return }
      const status = (e as { status?: number } | undefined)?.status
      const message = (e as { message?: string } | undefined)?.message ?? ""
      if (status === 409 && message.toLowerCase().includes("offline")) {
        toast.error("Bot is offline — bring it online before resetting.")
      } else {
        toastApiError(e, "Couldn't reset the bot's session")
      }
    } finally {
      try { assert(); setResetBotId((current) => current === id ? null : current) } catch {}
    }
  }

  const resetConfirmedMachine = async () => {
    if (!confirmResetMachine) return
    const assert = source.capture(), id = confirmResetMachine
    assert()
    const name = machineName(confirmResetMachine)
    try {
      const { dispatched } = await resetMachineAgents.mutateAsync({ id: confirmResetMachine, assertActive: assert })
      assert()
      toast.success(
        `Dispatched reset to ${dispatched} agent${dispatched === 1 ? "" : "s"} on ${name}.`,
      )
    } catch (e) {
      try { assert() } catch { return }
      const status = (e as { status?: number } | undefined)?.status
      const message = (e as { message?: string } | undefined)?.message ?? ""
      if (status === 409 && message.toLowerCase().includes("offline")) {
        toast.error(`${name} is offline — bring it online before resetting.`)
      } else {
        toastApiError(e, "Couldn't reset the machine's agents")
      }
    } finally {
      try { assert(); setConfirmResetMachine((current) => current === id ? null : current) } catch {}
    }
  }

  return {
    viewPlan,
    billingOpen,
    setBillingOpen,
    canShowLimit,
    bots,
    planSummary,
    isCreateDisabled,
    pendingActiveBotIds,
    setBotActive,
    isLoading,
    machines,
    machinesLoading,
    profilesByUserId,
    createOpen,
    setCreateOpen,
    editingBot,
    setEditingBot,
    editOpen,
    setEditOpen,
    activityBot,
    activityOpen,
    activityGeneration,
    openActivity,
    onActivityOpenChange,
    onActivityOpenChangeComplete,
    bugReportBot,
    setBugReportBot,
    bugReportOpen,
    setBugReportOpen,
    confirmDelete,
    setConfirmDelete,
    confirmReset,
    setConfirmReset,
    confirmResetMachine,
    setConfirmResetMachine,
    collapsedMachines,
    setCollapsedMachines,
    helpOpen,
    setHelpOpen,
    guidedActive,
    guidedCreateLabel,
    guidedAvatarSeed: guidedActive ? onboardingState.guideAvatarSeed : undefined,
    groups,
    highlightId,
    groupRefs,
    chatWithBot,
    onBotCreated,
    openGuidedCreate,
    openMachines,
    bringMachineOnline,
    machineName,
    deleteConfirmedBot,
    resetConfirmedBot,
    resetConfirmedMachine,
  }
}
