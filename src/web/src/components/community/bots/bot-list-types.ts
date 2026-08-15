import type { Dispatch, SetStateAction } from "react"
import type { CommunityMachineSummary } from "@alook/shared"
import type { BotSummary } from "@/hooks/community/use-bots"

export type BotListProps = {
  onBack?: () => void
}

export type BotMachineGroup = {
  machineId: string
  machine: CommunityMachineSummary | null
  bots: BotSummary[]
}

export type BotListController = {
  bots: BotSummary[]
  isLoading: boolean
  machines: CommunityMachineSummary[]
  machinesLoading: boolean
  onlineUserIds: ReadonlySet<string>
  createOpen: boolean
  setCreateOpen: Dispatch<SetStateAction<boolean>>
  editingBot: BotSummary | null
  setEditingBot: Dispatch<SetStateAction<BotSummary | null>>
  editOpen: boolean
  setEditOpen: Dispatch<SetStateAction<boolean>>
  activityBot: BotSummary | null
  setActivityBot: Dispatch<SetStateAction<BotSummary | null>>
  activityOpen: boolean
  setActivityOpen: Dispatch<SetStateAction<boolean>>
  bugReportBot: Pick<BotSummary, "id" | "name"> | null
  setBugReportBot: Dispatch<SetStateAction<Pick<BotSummary, "id" | "name"> | null>>
  bugReportOpen: boolean
  setBugReportOpen: Dispatch<SetStateAction<boolean>>
  confirmDelete: BotSummary | null
  setConfirmDelete: Dispatch<SetStateAction<BotSummary | null>>
  confirmReset: BotSummary | null
  setConfirmReset: Dispatch<SetStateAction<BotSummary | null>>
  confirmResetMachine: string | null
  setConfirmResetMachine: Dispatch<SetStateAction<string | null>>
  collapsedMachines: Set<string>
  setCollapsedMachines: Dispatch<SetStateAction<Set<string>>>
  helpOpen: boolean
  setHelpOpen: Dispatch<SetStateAction<boolean>>
  guidedActive: boolean
  guidedCreateLabel: string
  guidedAvatarSeed: string | undefined
  groups: BotMachineGroup[]
  highlightId: string | null
  groupRefs: { current: Record<string, HTMLDivElement | null> }
  chatWithBot: (bot: BotSummary) => Promise<void>
  onBotCreated: (bot: BotSummary) => Promise<void>
  openGuidedCreate: () => void
  openMachines: () => void
  bringMachineOnline: (machineId: string) => void
  machineName: (machineId: string) => string
  deleteConfirmedBot: () => Promise<void>
  resetConfirmedBot: () => Promise<void>
  resetConfirmedMachine: () => Promise<void>
}

export type BotListOverlaySlots = {
  create: React.ReactElement
  help: React.ReactElement
  edit: React.ReactElement
  activity: React.ReactElement
  bug: React.ReactElement | null
  deleteDialog: React.ReactElement
  resetDialog: React.ReactElement
  resetMachineDialog: React.ReactElement
}
