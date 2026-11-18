import { z } from "zod"
import { AutomationPermissionPolicySchema, BillingSummarySchema, PublicPricingSchema, type CommunityCollectionRows } from "@alook/shared"
import { auxiliaryWindowRetiredKeys, auxiliaryWindowScopeKey, MAX_PERSISTED_AUXILIARY_ROWS, type AuxiliaryReadReference } from "./auxiliary-window-contract"

export type DisplayDomain = "community" | "application"
export type DisplayReadProof = { observed?: boolean; auxiliaryReadEpoch?: string }
const id = z.string().min(1)
const timestamp = z.iso.datetime({ offset: true })
const proof = { observed: z.boolean().optional(), auxiliaryReadEpoch: z.uuid().optional() }
const code = z.object({ id, purpose: z.literal("onboarding").nullable().optional(), name: z.string(), createdAt: timestamp,
  expiresAt: timestamp.nullable(), permissions: z.array(AutomationPermissionPolicySchema).min(1) })
export const AccessCodeDisplaySchema = z.object({ accessCodes: z.array(code), ...proof })
  .refine(value => new Set(value.accessCodes.map(row => row.id)).size === value.accessCodes.length)
const billing = BillingSummarySchema.extend(proof).refine(value => value.offers.length <= MAX_PERSISTED_AUXILIARY_ROWS
  && new Set(value.offers.map(row => row.priceId)).size === value.offers.length)
const pricing = PublicPricingSchema.extend(proof).refine(value => value.offers.length <= MAX_PERSISTED_AUXILIARY_ROWS
  && new Set(value.offers.map(row => row.priceId)).size === value.offers.length)
const marked = z.object({ marked: z.boolean(), scopeRef: z.object({ channelId: id, serverId: id.nullable().optional(), parentChannelId: id.nullable().optional() }).optional(), ...proof })
const reaction = z.object({ messageId: id,
  scope: z.discriminatedUnion("kind", [z.object({ kind: z.literal("dm"), channelId: id }), z.object({ kind: z.literal("server"), channelId: id, serverId: id })]),
  actors: z.array(z.object({ userId: id, profilePresent: z.boolean() })).max(MAX_PERSISTED_AUXILIARY_ROWS), ...proof,
}).refine(value => new Set(value.actors.map(row => row.userId)).size === value.actors.length)

export type DisplayWindow =
  | { kind: "access-codes"; domain: "community"; accountId: string; data: z.infer<typeof AccessCodeDisplaySchema> }
  | { kind: "billing"; domain: DisplayDomain; accountId?: string; data: z.infer<typeof billing> }
  | { kind: "pricing"; domain: "application"; data: z.infer<typeof pricing> }
  | { kind: "marked"; domain: "community"; messageId: string; data: z.infer<typeof marked> }
  | { kind: "reactions"; domain: "community"; messageId: string; data: z.infer<typeof reaction> }

export function displayWindowIdentity(key: readonly unknown[]): { kind: DisplayWindow["kind"]; domain: DisplayDomain; id?: string } | undefined {
  if (key.length === 1 && key[0] === "public-pricing") return { kind: "pricing", domain: "application" }
  if (key.length === 3 && key[0] === "application" && typeof key[1] === "string" && key[1] && !key[1].startsWith("__") && key[2] === "billing")
    return { kind: "billing", domain: "application", id: key[1] }
  if (key[0] !== "community") return
  if (key.length === 2 && key[1] === "billing") return { kind: "billing", domain: "community" }
  if (key.length === 3 && typeof key[2] === "string" && key[2]) {
    if (key[1] === "automation-access-codes") return { kind: "access-codes", domain: "community", id: key[2] }
    if (key[1] === "reaction-details") return { kind: "reactions", domain: "community", id: key[2] }
  }
  if (key.length === 4 && key[1] === "message" && typeof key[2] === "string" && key[2] && key[3] === "marked")
    return { kind: "marked", domain: "community", id: key[2] }
}

export function readDisplayWindow(key: readonly unknown[], value: unknown): DisplayWindow | undefined {
  const identity = displayWindowIdentity(key)
  if (!identity) return
  if (identity.kind === "access-codes") {
    const parsed = AccessCodeDisplaySchema.safeParse(value)
    if (parsed.success && parsed.data.accessCodes.length <= MAX_PERSISTED_AUXILIARY_ROWS) return { kind: "access-codes", domain: "community", accountId: identity.id!, data: { ...parsed.data, observed: false } }
  } else if (identity.kind === "billing") {
    const parsed = billing.safeParse(value)
    if (parsed.success) return { kind: "billing", domain: identity.domain, accountId: identity.id, data: { ...parsed.data, observed: false } }
  } else if (identity.kind === "pricing") {
    const parsed = pricing.safeParse(value)
    if (parsed.success) return { kind: "pricing", domain: "application", data: { ...parsed.data, observed: false } }
  } else if (identity.kind === "marked") {
    const parsed = marked.safeParse(value)
    if (parsed.success) return { kind: "marked", domain: "community", messageId: identity.id!, data: { ...parsed.data, observed: false } }
  } else {
    const parsed = reaction.safeParse(value)
    if (parsed.success && parsed.data.messageId === identity.id) return { kind: "reactions", domain: "community", messageId: identity.id!, data: { ...parsed.data, observed: false } }
  }
}

export function displayWindowScopeKeys(window: DisplayWindow) {
  const scopes = window.kind === "access-codes" ? [{ kind: "access-code-list" as const, id: window.accountId }, ...window.data.accessCodes.map(row => ({ kind: "access-code" as const, id: row.id }))]
    : window.kind === "marked" ? [{ kind: "message" as const, id: window.messageId }, { kind: "message-marked" as const, id: window.messageId },
      ...(window.data.scopeRef ? [{ kind: "channel-resource" as const, id: window.data.scopeRef.channelId },
        ...(window.data.scopeRef.parentChannelId ? [{ kind: "channel-resource" as const, id: window.data.scopeRef.parentChannelId }] : []),
        ...(window.data.scopeRef.serverId ? [{ kind: "server-resource" as const, id: window.data.scopeRef.serverId }] : [])] : [])]
      : window.kind === "reactions" ? [{ kind: "message" as const, id: window.messageId }, { kind: "reaction-message" as const, id: window.messageId },
        { kind: "channel-resource" as const, id: window.data.scope.channelId },
        ...(window.data.scope.kind === "server" ? [{ kind: "server" as const, id: window.data.scope.serverId }, { kind: "server-resource" as const, id: window.data.scope.serverId }, { kind: "reaction-server" as const, id: window.data.scope.serverId }]
          : [{ kind: "reaction-dm" as const, id: "all" }])]
        : []
  return new Set(scopes.map(auxiliaryWindowScopeKey))
}

export function displayWindowRetiredKeys(window: DisplayWindow, retired: ReadonlyMap<string, { epoch: string }>, reference?: AuxiliaryReadReference) {
  return auxiliaryWindowRetiredKeys([window.data], retired, reference)
}

type Rows = Partial<{ [N in "servers" | "channels" | "serverMemberships" | "channelMemberships" | "messages" | "profiles"]: CommunityCollectionRows[N][] }>
export function displayWindowComplete(window: DisplayWindow, rows: Rows, viewer: string | null, domain: DisplayDomain, retired: ReadonlySet<string> = new Set()) {
  if (window.domain !== domain || window.kind !== "pricing" && !viewer) return false
  if ((window.kind === "access-codes" || window.kind === "billing") && window.accountId !== undefined && window.accountId !== viewer) return false
  if ([...displayWindowScopeKeys(window)].some(key => retired.has(key))) return false
  if (window.kind !== "reactions") return true
  const { scope, actors } = window.data
  const channel = rows.channels?.find(row => row.id === scope.channelId)
  if (!channel || channel.pending || retired.has(channel.id)
    || !rows.messages?.some(row => row.id === window.messageId && row.channelId === channel.id)
    || !rows.channelMemberships?.some(row => row.channelId === channel.id && row.userId === viewer && row.relation === "access")) return false
  if (scope.kind === "dm" ? channel.type !== "dm" : channel.serverId !== scope.serverId
    || !rows.servers?.some(row => row.id === scope.serverId)
    || !rows.serverMemberships?.some(row => row.serverId === scope.serverId && row.userId === viewer && row.viewer)) return false
  if (channel.parentChannelId && (!rows.channels?.some(row => row.id === channel.parentChannelId && !row.pending && row.serverId === channel.serverId && !retired.has(row.id))
    || !rows.channelMemberships?.some(row => row.channelId === channel.parentChannelId && row.userId === viewer && row.relation === "access"))) return false
  return actors.every(actor => !actor.profilePresent || rows.profiles?.some(profile => profile.id === actor.userId))
}
