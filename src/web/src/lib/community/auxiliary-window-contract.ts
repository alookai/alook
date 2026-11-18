export const MAX_PERSISTED_AUXILIARY_WINDOWS = 20
export const MAX_PERSISTED_AUXILIARY_ROWS = 400
export const AUXILIARY_READ_EPOCH_KEY = JSON.stringify(["auxiliary-window", "read-generation"])

function isAuxiliaryWindowScopeKey(key: string) {
  return key.startsWith('["auxiliary-window",')
}

export type AuxiliaryWindowScope =
  | { kind: "server" | "invite" | "friendship" | "bot" | "bot-memberships" | "server-admin" | "server-resource" | "channel-resource" | "message"; id: string }
  | { kind: "bot-server" | "bot-channel"; botId: string; id: string }
  | { kind: "server-member"; serverId: string; memberId: string }
  | { kind: "channel-member"; channelId: string; userId: string; relation: "access" | "notify" }

export function auxiliaryWindowScopeKey(scope: AuxiliaryWindowScope) {
  const fields = scope.kind === "server-member" ? [scope.kind, scope.serverId, scope.memberId]
    : scope.kind === "channel-member" ? [scope.kind, scope.channelId, scope.userId, scope.relation]
      : scope.kind === "bot-server" || scope.kind === "bot-channel" ? [scope.kind, scope.botId, scope.id]
      : [scope.kind, scope.id]
  if (fields.some(value => !value)) throw new Error("Invalid auxiliary scope")
  return JSON.stringify(["auxiliary-window", ...fields])
}

export type AuxiliaryReadReference = { epochs: ReadonlySet<string>; scopes: ReadonlySet<string>; changed: ReadonlySet<string> }

export function auxiliaryWindowRetiredKeys(reads: readonly { auxiliaryReadEpoch?: string }[], retired: ReadonlyMap<string, { epoch: string }>, reference?: AuxiliaryReadReference) {
  const epoch = retired.get(AUXILIARY_READ_EPOCH_KEY)?.epoch
  const current = !!epoch && reads.every(read => read.auxiliaryReadEpoch === epoch)
  const retained = !!reference && reads.every(read => !!read.auxiliaryReadEpoch && (read.auxiliaryReadEpoch === epoch || reference.epochs.has(read.auxiliaryReadEpoch)))
  return new Set([...retired.keys()].filter(key => {
    if (!isAuxiliaryWindowScopeKey(key) || ["server-resource", "channel-resource", "message"].some(kind => key.startsWith(`["auxiliary-window","${kind}",`))) return true
    return !current && !(retained && reference?.scopes.has(key) && !reference.changed.has(key))
  }))
}
