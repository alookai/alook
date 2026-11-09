import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { promisifyRequest } from "idb-keyval"
import { cacheTransaction } from "./query-cache-store"

export const PERSIST_VERSION = BUSINESS_SCHEMA_VERSION
export const PERSIST_BUSTER = String(PERSIST_VERSION)
export const PERSIST_CACHE_PREFIX = `alook:business:v${BUSINESS_SCHEMA_VERSION}`
export const PERSIST_ACCOUNT_PREFIX = "alook:qc:cache"
export const DEVICE_EPOCH_KEY = "alook:qc:device-epoch"
export const LAST_ACCOUNT_KEY = "alook:qc:last-account"
export const scopeEpochKey = (key: string) => `${key}:epoch`
export const accountEpochKey = (userId: string | null) => `${PERSIST_ACCOUNT_PREFIX}:${userId ?? "anon"}:account-epoch`
export function blobKeyFor(userId: string | null, domain: "community" | "application" = "community"): string {
  return `${PERSIST_CACHE_PREFIX}:${userId ?? "anon"}${domain === "application" ? ":application" : ""}:client`
}
export type PersistedAccountIdentity = { id: string; email: string }
export type AccountIdentityRecord = PersistedAccountIdentity & { version: number; device: string; account: string; scope: string }
export const isEpoch = (value: unknown): value is string => (
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
)
export function communityScopeEpoch(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const scope = value as Record<string, unknown>
  return Object.keys(scope).length === 2 && scope.version === PERSIST_VERSION && isEpoch(scope.epoch)
    ? scope.epoch : undefined
}
export function accountIdentityRecord(value: unknown): AccountIdentityRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as AccountIdentityRecord
  return record.version === PERSIST_VERSION && typeof record.id === "string" && record.id.length > 0
    && typeof record.email === "string" && record.email.length > 0
    && isEpoch(record.device) && isEpoch(record.account) && isEpoch(record.scope) ? record : undefined
}
export async function readPersistedAccountClaim(store: IDBObjectStore): Promise<AccountIdentityRecord | undefined> {
  const identity = accountIdentityRecord(await promisifyRequest<unknown>(store.get(LAST_ACCOUNT_KEY)))
  if (!identity) return undefined
  const [device, account, scope] = await Promise.all([
    promisifyRequest<unknown>(store.get(DEVICE_EPOCH_KEY)),
    promisifyRequest<unknown>(store.get(accountEpochKey(identity.id))),
    promisifyRequest<unknown>(store.get(scopeEpochKey(blobKeyFor(identity.id)))),
  ])
  return device === identity.device && account === identity.account && communityScopeEpoch(scope) === identity.scope ? identity : undefined
}
export function capturePersistedAccountIdentity(): Promise<AccountIdentityRecord | undefined> {
  return cacheTransaction("readonly", readPersistedAccountClaim)
}
