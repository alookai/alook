import type { QueryClient, Query, Mutation } from "@tanstack/react-query"
import { messageObservation, disposeMessageObservations } from "./messages"
import { actionNames } from "./coverage"
import { resolveActionName } from "./actions"
import { startAction, finishAction, bindCommandAction, type Action } from "./context"
import { currentSource, disposeSources, forgetCollection, tagValue, observedValueSource } from "./data-source"
import { isTelemetryEligible, emitTelemetry } from "./telemetry"

const clients = new WeakMap<QueryClient, () => void>()
const allowed = new Set<string>(actionNames)
export function observeQueryClient(client: QueryClient) {
  if (clients.has(client)) return client
  const actions = new WeakMap<Mutation, Action>()
  const data = new WeakMap<Query, unknown>()
  const stopQueries = client.getQueryCache().subscribe(event => {
    if (!isTelemetryEligible()) return
    if (event.type === "removed") {
      data.delete(event.query)
      if (event.query.queryKey[0] === "community" && event.query.queryKey[1] === "db") forgetCollection(client, String(event.query.queryKey[3]))
      return
    }
    if (event.type !== "updated" || event.action.type !== "success") return
    const query = event.query, value = query.state.data, previous = data.get(query)
    const source = event.action.manual ? currentSource(client) : observedValueSource(value)
    tagValue(client, value, source, previous)
    data.set(query, value)
  })
  const stopMutations = client.getMutationCache().subscribe(event => {
    if (event.type !== "updated") return
    const mutation = event.mutation
    if (mutation.options.meta?.observabilityDelegate === true) return
    if (event.action.type === "pending" && isTelemetryEligible()) {
      if (actions.has(mutation)) return
      const base = mutation.options.meta?.observabilityAction
      const name = typeof base === "string" ? resolveActionName(base, mutation.state.variables) : "command.unknown"
      const input = mutation.state.variables && typeof mutation.state.variables === "object" ? mutation.state.variables as Record<string, unknown> : {}
      const accepted = ["channel.message.send", "dm.message.send"].includes(name) ? messageObservation(client, input.nonce) : undefined
      const action = accepted ?? startAction(allowed.has(name) ? name : "command.unknown")
      if (action) { actions.set(mutation, action); bindCommandAction(mutation.state.variables, action) }
      if (name === "command.unknown") emitTelemetry("telemetry.coverage", { capability: "limited", action_name: name })
    } else if (event.action.type === "success" || event.action.type === "error") {
      const error = mutation.state.error
      finishAction(actions.get(mutation), event.action.type === "success" ? "success" : error instanceof Error && error.name === "AbortError" ? "cancelled" : "error", { phase: "primary" })
      actions.delete(mutation)
    }
  })
  clients.set(client, () => { stopQueries(); stopMutations(); disposeSources(client); disposeMessageObservations(client); clients.delete(client) })
  return client
}
export function disposeQueryDiagnostics(client: QueryClient) { clients.get(client)?.() }
