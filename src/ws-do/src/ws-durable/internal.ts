import type { Logger } from "@alook/shared"

export const COMMUNITY_DELIVERY_PROGRESS_LIMIT = 64
export const COMMUNITY_CONNECTION_STATE_JSON_MAX_BYTES = 12 * 1024

export type CompactCommunityDeliveryProgress = [
  operationId: string,
  operationDigest: string,
  nextFrameIndex: number,
  frameCount: number,
]

export type ConnectionState =
  | {
    type: "user"
    userId: string
    targetUserId?: string
    authenticated: boolean
    name?: string
    discriminator?: string
    communityDeliveryProgress?: CompactCommunityDeliveryProgress[]
  }
  | { type: "daemon"; daemonId: string; userId: string; authenticated: boolean }
  | {
    type: "community-machine"
    machineId: string
    userId: string
    authenticated: boolean
    controlHeartbeat?: boolean
    lastHeartbeatAckAt?: number
    pendingHeartbeatNonce?: string
  }

export type UserConnectionState = Extract<ConnectionState, { type: "user" }>
export type CommunityMachineConnectionState = Extract<ConnectionState, { type: "community-machine" }>

export interface CommunityMachineIdentity {
  userId: string
  machineId: string
  credentialHash: string
}

export interface CommunityMachineHandle {
  userId: string
  machineId: string
}

export const IDENTITY_KEY = "community-machine-identity"
export const HANDLE_KEY = "community-machine-handle"
export const RUNTIME_ERROR_KEY = "community-machine-runtime-error"
export const DIAGNOSTIC_ALARM_HINT_KEY = "community-machine-diagnostic-alarm-hint"
const RESTART_PENDING_PREFIX = "reset-pending:"
export const restartPendingKey = (launchId: string) => RESTART_PENDING_PREFIX + launchId

export type ResetTrigger = "single" | "reset_all" | "nap"
export type RestartAttribution =
  | { kind: "session_reset"; trigger: "single" | "reset_all" }
  | { kind: "nap" }
  | { kind: "model_switch"; from: string | null; to: string | null }
  | { kind: "provider_switch"; from: string; to: string }

export function normalizeRestartAttribution(value: ResetTrigger | RestartAttribution): RestartAttribution {
  if (typeof value !== "string") return value
  return value === "nap" ? { kind: "nap" } : { kind: "session_reset", trigger: value }
}

export interface WsDurableContext {
  readonly ctx: DurableObjectState
  readonly env: Env
  readonly log: Logger
  readonly typingDedup: Map<string, Map<string, number>>
  readonly typingDedupMs: number
  readonly subrequestBatchSize: number
}
