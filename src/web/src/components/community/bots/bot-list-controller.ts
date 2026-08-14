"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { isPresenceOnline } from "@alook/shared"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { machineName as resolveMachineName } from "@/lib/community/machine-name"
import { useMachines } from "@/hooks/community/use-machines"
import {
  useBots,
  useDeleteBot,
  useResetBotSession,
  useResetMachineAgents,
  type BotSummary,
} from "@/hooks/community/use-bots"
import { useCreateOrGetDm } from "@/hooks/community/mutations"
import { useOnlineUserIds } from "@/stores/community/ws"
import {
  advanceCommunityOnboarding,
  readCommunityOnboardingState,
  recoverCommunityOnboardingMachine,
  updateCommunityOnboardingResources,
  useCommunityOnboarding,
} from "@/lib/community-onboarding"
import type { BotListController } from "./bot-list-types"

export function useBotListController(): BotListController {
  const router = useRouter()
  const searchParams = useSearchParams()
  const botsQuery = useBots()
  const { bots, isLoading } = botsQuery
  const { machines, isLoading: machinesLoading } = useMachines()
  const onlineUserIds = useOnlineUserIds()
  const [createOpen, setCreateOpen] = useState(false)
  const [editingBot, setEditingBot] = useState<BotSummary | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [activityBot, setActivityBot] = useState<BotSummary | null>(null)
  const [activityOpen, setActivityOpen] = useState(false)
  const [bugReportBot, setBugReportBot] = useState<Pick<BotSummary, "id" | "name"> | null>(null)
  const [bugReportOpen, setBugReportOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<BotSummary | null>(null)
  const [confirmReset, setConfirmReset] = useState<BotSummary | null>(null)
  const [confirmResetMachine, setConfirmResetMachine] = useState<string | null>(null)
  const [collapsedMachines, setCollapsedMachines] = useState<Set<string>>(
    () => new Set(),
  )
  const [helpOpen, setHelpOpen] = useState(false)
  const del = useDeleteBot()
  const resetSession = useResetBotSession()
  const resetMachineAgents = useResetMachineAgents()
  const createOrGetDm = useCreateOrGetDm()
  const onboardingState = useCommunityOnboarding()
  const guidedActive = onboardingState?.status === "active" && onboardingState.stage === "bot"
  const guidedPendingBotId = guidedActive ? onboardingState.botId : undefined
  const guidedNeedsMachine =
    guidedActive && !machines.some((machine) => isPresenceOnline(machine.status))

  const chatWithBot = async (bot: BotSummary) => {
    try {
      const data = await createOrGetDm.mutateAsync({ userId: bot.id })
      router.push(`/c/me/${data.conversation.id}`)
    } catch (e) {
      toastApiError(e, "Failed to open chat")
    }
  }

  const openGuidedBotDm = async (botId: string) => {
    try {
      const data = await createOrGetDm.mutateAsync({ userId: botId })
      advanceCommunityOnboarding("bot", "dm", {
        botId,
        dmId: data.conversation.id,
      })
      router.push(`/c/me/${data.conversation.id}`)
    } catch (e) {
      toastApiError(e, "Bot created, but the chat couldn't open")
    }
  }

  const onBotCreated = async (bot: BotSummary) => {
    const state = readCommunityOnboardingState()
    if (state?.status !== "active" || state.stage !== "bot") return
    updateCommunityOnboardingResources({ botId: bot.id })
    await openGuidedBotDm(bot.id)
  }

  const openGuidedCreate = () => {
    const state = readCommunityOnboardingState()
    const hasUsableMachine = machines.some((machine) => isPresenceOnline(machine.status))
    if (state?.status === "active" && state.stage === "bot" && !hasUsableMachine) {
      recoverCommunityOnboardingMachine()
      router.push("/c/me/machines")
      return
    }
    if (state?.status === "active" && state.stage === "bot" && state.botId) {
      void openGuidedBotDm(state.botId)
      return
    }
    setCreateOpen(true)
  }

  const guidedCreateLabel = guidedNeedsMachine
    ? "Connect a machine"
    : guidedPendingBotId
      ? "Open bot chat"
      : "Create a bot"

  const machineName = (id: string): string => {
    const machine = machines.find((item) => item.id === id)
    if (!machine) return "Unknown machine"
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
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const scrolledForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!targetMachineId || bots.length === 0) return
    setCollapsedMachines((current) => {
      if (!current.has(targetMachineId)) return current
      const next = new Set(current)
      next.delete(targetMachineId)
      return next
    })
    if (scrolledForRef.current === targetMachineId) return
    scrolledForRef.current = targetMachineId
    groupRefs.current[targetMachineId]?.scrollIntoView({ behavior: "smooth", block: "start" })
    setHighlightId(targetMachineId)
    const timer = setTimeout(() => setHighlightId(null), 2000)
    return () => clearTimeout(timer)
  }, [targetMachineId, bots.length])

  const openMachines = () => router.push("/c/me/machines")
  const bringMachineOnline = (machineId: string) => {
    router.push(`/c/me/machines?reconnect=${machineId}`)
  }

  const deleteConfirmedBot = async () => {
    if (!confirmDelete) return
    const name = confirmDelete.name
    try {
      await del.mutateAsync(confirmDelete.id)
      toast.success(`Deleted ${name}`)
    } catch (e) {
      toastApiError(e, "Couldn't delete the bot")
    } finally {
      setConfirmDelete(null)
    }
  }

  const resetConfirmedBot = async () => {
    if (!confirmReset) return
    try {
      await resetSession.mutateAsync(confirmReset.id)
      toast.success("Session reset.")
    } catch (e) {
      const status = (e as { status?: number } | undefined)?.status
      const message = (e as { message?: string } | undefined)?.message ?? ""
      if (status === 409 && message.toLowerCase().includes("offline")) {
        toast.error("Bot is offline — bring it online before resetting.")
      } else {
        toastApiError(e, "Couldn't reset the bot's session")
      }
    } finally {
      setConfirmReset(null)
    }
  }

  const resetConfirmedMachine = async () => {
    if (!confirmResetMachine) return
    const name = machineName(confirmResetMachine)
    try {
      const { dispatched } = await resetMachineAgents.mutateAsync(confirmResetMachine)
      toast.success(
        `Dispatched reset to ${dispatched} agent${dispatched === 1 ? "" : "s"} on ${name}.`,
      )
    } catch (e) {
      const status = (e as { status?: number } | undefined)?.status
      const message = (e as { message?: string } | undefined)?.message ?? ""
      if (status === 409 && message.toLowerCase().includes("offline")) {
        toast.error(`${name} is offline — bring it online before resetting.`)
      } else {
        toastApiError(e, "Couldn't reset the machine's agents")
      }
    } finally {
      setConfirmResetMachine(null)
    }
  }

  return {
    bots,
    isLoading,
    machines,
    machinesLoading,
    onlineUserIds,
    createOpen,
    setCreateOpen,
    editingBot,
    setEditingBot,
    editOpen,
    setEditOpen,
    activityBot,
    setActivityBot,
    activityOpen,
    setActivityOpen,
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
