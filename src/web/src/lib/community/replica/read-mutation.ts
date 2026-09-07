import { apiFetch } from "@/lib/api/client"

export type CommunityReplicaReadMutation = {
  channelId: string
  messageId: string
  seq: number
}

export type CommunityReplicaReadMutationResponse = {
  changed: boolean
  revision: number
  targetSeq: number
}

type ReadMutationFlight = {
  accountId: string
  mutation: CommunityReplicaReadMutation
  promise: Promise<CommunityReplicaReadMutationResponse>
  controller: AbortController
  signals: Map<AbortSignal, () => void>
  fulfilled: boolean
}

const readMutationFlights = new Map<string, ReadMutationFlight>()

function mutationKey(accountId: string, mutation: CommunityReplicaReadMutation) {
  return JSON.stringify([
    accountId,
    mutation.channelId,
    mutation.messageId,
    mutation.seq,
  ])
}

function releaseSignals(flight: ReadMutationFlight) {
  for (const [signal, release] of flight.signals) {
    signal.removeEventListener("abort", release)
  }
  flight.signals.clear()
}

function attachSignal(key: string, flight: ReadMutationFlight, signal: AbortSignal) {
  if (flight.fulfilled || flight.signals.has(signal)) return
  const release = () => {
    signal.removeEventListener("abort", release)
    flight.signals.delete(signal)
    if (
      flight.signals.size === 0
      && !flight.fulfilled
      && readMutationFlights.get(key) === flight
    ) flight.controller.abort()
  }
  if (signal.aborted) {
    release()
    return
  }
  flight.signals.set(signal, release)
  signal.addEventListener("abort", release, { once: true })
}

export function sendCommunityReplicaReadMutation(
  accountId: string,
  mutation: CommunityReplicaReadMutation,
  signal: AbortSignal,
) {
  const key = mutationKey(accountId, mutation)
  const current = readMutationFlights.get(key)
  if (current && (current.fulfilled || !current.controller.signal.aborted)) {
    attachSignal(key, current, signal)
    return current.promise
  }

  const controller = new AbortController()
  const request = apiFetch<CommunityReplicaReadMutationResponse>(
    `/api/community/channels/${mutation.channelId}/read`,
    {
      method: "PUT",
      body: JSON.stringify({ lastReadMessageId: mutation.messageId }),
      signal: controller.signal,
    },
  )
  const flight: ReadMutationFlight = {
    accountId,
    mutation,
    promise: request,
    controller,
    signals: new Map(),
    fulfilled: false,
  }
  flight.promise = request.then((response) => {
    flight.fulfilled = true
    releaseSignals(flight)
    return response
  }).catch((error) => {
    releaseSignals(flight)
    if (readMutationFlights.get(key) === flight) readMutationFlights.delete(key)
    throw error
  })
  readMutationFlights.set(key, flight)
  attachSignal(key, flight, signal)
  return flight.promise
}

export function settleCommunityReplicaReadMutations(
  accountId: string,
  channelId: string,
  confirmedSeq: number,
) {
  for (const [key, flight] of readMutationFlights) {
    if (
      flight.accountId !== accountId
      || flight.mutation.channelId !== channelId
      || flight.mutation.seq > confirmedSeq
    ) continue
    releaseSignals(flight)
    readMutationFlights.delete(key)
  }
}

export function discardCommunityReplicaReadMutations(
  accountId: string,
  channelId: string,
) {
  for (const [key, flight] of readMutationFlights) {
    if (flight.accountId !== accountId || flight.mutation.channelId !== channelId) continue
    releaseSignals(flight)
    readMutationFlights.delete(key)
  }
}

export function clearCommunityReplicaReadMutations(accountId: string) {
  for (const [key, flight] of readMutationFlights) {
    if (flight.accountId !== accountId) continue
    releaseSignals(flight)
    readMutationFlights.delete(key)
  }
}
