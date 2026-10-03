
import type { Atom } from "@tanstack/react-store"
import type { BotPlanSummary, BotSummary } from "@/hooks/community/use-bots"
import type { MachineSummary } from "@/hooks/community/use-machines"
import type { CommunityProfile } from "@/lib/community/models/people"

export type BotListProps = {
  onBack?: () => void
}

export type BotMachineGroup = {
  machineId: string
  machine: MachineSummary | null
  bots: BotSummary[]
}

export type BotListController = {
  viewPlan: () => void
  billingOpen: boolean
  setBillingOpen: (open: boolean) => void
  canShowLimit: boolean
  bots: BotSummary[]
  planSummary: BotPlanSummary | null
  isCreateDisabled: boolean
  pendingActiveBotIds: ReadonlySet<string>
  setBotActive: (bot: BotSummary, active: boolean) => Promise<void>
  isLoading: boolean
  machines: MachineSummary[]
  machinesLoading: boolean
  profilesByUserId: ReadonlyMap<string, CommunityProfile>
  createOpen: boolean
  setCreateOpen: Atom<boolean>["set"]
  editingBot: BotSummary | null
  setEditingBot: (bot: BotSummary | null) => void
  editOpen: boolean
  setEditOpen: Atom<boolean>["set"]
  activityBot: BotSummary | null
  activityOpen: boolean
  activityGeneration: number
  openActivity: (bot: BotSummary) => void
  onActivityOpenChange: (open: boolean) => void
  onActivityOpenChangeComplete: (open: boolean, generation: number) => void
  bugReportBot: Pick<BotSummary, "id" | "name"> | null
  setBugReportBot: (bot: Pick<BotSummary, "id" | "name"> | null) => void
  bugReportOpen: boolean
  setBugReportOpen: Atom<boolean>["set"]
  confirmDelete: BotSummary | null
  setConfirmDelete: (bot: BotSummary | null) => void
  confirmReset: BotSummary | null
  setConfirmReset: (bot: BotSummary | null) => void
  confirmResetMachine: string | null
  setConfirmResetMachine: Atom<string | null>["set"]
  collapsedMachines: Set<string>
  setCollapsedMachines: Atom<Set<string>>["set"]
  helpOpen: boolean
  setHelpOpen: Atom<boolean>["set"]
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
  billing: React.ReactElement
  create: React.ReactElement
  help: React.ReactElement
  edit: React.ReactElement
  activity: React.ReactElement
  bug: React.ReactElement | null
  deleteDialog: React.ReactElement
  resetDialog: React.ReactElement
  resetMachineDialog: React.ReactElement
}
