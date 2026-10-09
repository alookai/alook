import type { QueryClient, Query, Mutation } from "@tanstack/react-query"
import { messageObservation, disposeMessageObservations } from "./messages"
import { actionNames } from "./coverage"
import { resolveActionName } from "./actions"
import { startAction, finishAction, bindCommandAction, type Action } from "./context"
import { isTelemetryEligible, emitTelemetry, telemetryGeneration } from "./telemetry"

const clients = new WeakMap<QueryClient, () => void>()
const allowed = new Set<string>(actionNames)
export function observeQueryClient(client: QueryClient) {
  if (clients.has(client)) return client
  const actions = new WeakMap<Mutation, Action>()
  const queries = new WeakMap<Query, number>()
  const stopQueries = client.getQueryCache().subscribe(event => {
    if (event.type === "removed") { queries.delete(event.query); return }
    if (event.type !== "updated") return
    if (event.action.type === "fetch") queries.set(event.query, isTelemetryEligible() ? telemetryGeneration() : -1)
    else if (!["success", "error"].includes(event.action.type)) return
    const admitted = queries.get(event.query) === telemetryGeneration()
    if (event.action.type !== "fetch") queries.delete(event.query)
    if (!isTelemetryEligible() || !admitted) return
    emitTelemetry("query.lifecycle", { phase: "background", cache_stage: "query", outcome: event.action.type === "fetch" ? "observed" : event.action.type })
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
    } else if (event.action.type === "success" || event.action.type === "error") {
      const error = mutation.state.error
      finishAction(actions.get(mutation), event.action.type === "success" ? "success" : error instanceof Error && error.name === "AbortError" ? "cancelled" : "error", { phase: "primary" })
      actions.delete(mutation)
    }
  })
  clients.set(client, () => { stopQueries(); stopMutations(); disposeMessageObservations(client); clients.delete(client) })
  return client
}
export function disposeQueryDiagnostics(client: QueryClient) { clients.get(client)?.() }
