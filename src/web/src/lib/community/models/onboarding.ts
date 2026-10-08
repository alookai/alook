export type StarterPackBotKey = "lead" | "doer" | "reviewer"

export type OnboardingInitializationStep = "creating-bots" | "creating-room" | "inviting-bots" | "preparing-welcome"
export type OnboardingInitializedBot = { key: StarterPackBotKey; id: string }
export type OnboardingInitializationResult = {
  serverId: string
  publicChannelId: string
  privateChannelId: string
  leadBotId: string
  bots: OnboardingInitializedBot[]
}
export type OnboardingInitializationCheckpoint = {
  bots?: OnboardingInitializedBot[]
  serverId?: string
  publicChannelId?: string
  privateChannelId?: string
  tasksChannelId?: string
  requestedServerName?: string
  onboardedBotIds?: string[]
  botsOnboarded?: boolean
  leadAddedToPrivate?: boolean
}
export type OnboardingInitializationProtocol = {
  checkpoint: OnboardingInitializationCheckpoint
  step: OnboardingInitializationStep
  result: OnboardingInitializationResult | null
  pendingDestination: string | null
}
