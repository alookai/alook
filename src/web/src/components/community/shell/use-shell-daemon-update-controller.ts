"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type Dispatch } from "react"
import { parseReleaseVersion } from "@alook/shared"
import {
  eligibleDaemonUpdateMachines,
  requestMachineUpdate,
} from "@/components/daemon-update-notice"
import { useCommunityMutationOrigin } from "@/hooks/community/community-origin"
import { useMachines } from "@/hooks/community/use-machines"
import { log } from "@/lib/logger"
import type {
  UserBarExtensionAction,
  UserBarExtensionState,
  UserBarUpdateState,
} from "./user-bar-extension-state"

const STORAGE_KEY_PREFIX = "alook:daemon-update-collapsed"

export function daemonUpdateCollapseStorageKey(
  userId: string,
  latestDaemonVersion: string,
): string {
  return `${STORAGE_KEY_PREFIX}:${userId}:${latestDaemonVersion}`
}

function readCollapsed(userId: string, latestDaemonVersion: string): boolean {
  try {
    return window.localStorage.getItem(
      daemonUpdateCollapseStorageKey(userId, latestDaemonVersion),
    ) === "1"
  } catch {
    return false
  }
}

function writeCollapsed(
  userId: string,
  latestDaemonVersion: string,
  collapsed: boolean,
): void {
  try {
    const key = daemonUpdateCollapseStorageKey(userId, latestDaemonVersion)
    if (collapsed) window.localStorage.setItem(key, "1")
    else window.localStorage.removeItem(key)
  } catch {}
}

export function daemonUpdateRequestMachineIds(
  update: UserBarUpdateState,
  eligibleMachineIds: readonly string[],
): string[] {
  const eligible = new Set(eligibleMachineIds)
  if (update.phase === "retry") {
    return update.failedMachineIds.filter((machineId) => eligible.has(machineId))
  }
  const accepted = new Set(update.acceptedMachineIds)
  const pending = new Set(update.pendingMachineIds)
  return update.targetMachineIds.filter((machineId) => (
    eligible.has(machineId) && !accepted.has(machineId) && !pending.has(machineId)
  ))
}

export async function dispatchMachineUpdateRequests(
  machineIds: readonly string[],
  requestUpdate: (machineId: string) => Promise<unknown>,
): Promise<{ acceptedMachineIds: string[]; failedMachineIds: string[] }> {
  const results = await Promise.allSettled(machineIds.map(async (machineId) => {
    await requestUpdate(machineId)
    return machineId
  }))
  const acceptedMachineIds: string[] = []
  const failedMachineIds: string[] = []
  results.forEach((result, index) => {
    const machineId = machineIds[index]!
    if (result.status === "fulfilled") acceptedMachineIds.push(machineId)
    else failedMachineIds.push(machineId)
  })
  return { acceptedMachineIds, failedMachineIds }
}

export function useShellDaemonUpdateController({
  userId,
  extensionState,
  dispatch,
  latestDaemonVersion = process.env.NEXT_PUBLIC_LATEST_DAEMON_VERSION,
  requestUpdate = requestMachineUpdate,
}: {
  userId: string
  extensionState: UserBarExtensionState
  dispatch: Dispatch<UserBarExtensionAction>
  latestDaemonVersion?: string
  requestUpdate?: (machineId: string) => Promise<unknown>
}) {
  const origin = useCommunityMutationOrigin()
  const batchRef = useRef<{ machineIds: Set<string> } | null>(null)
  useLayoutEffect(() => () => { batchRef.current = null }, [origin.registry, userId, latestDaemonVersion])
  const machines = useMachines()
  const eligibleMachines = useMemo(() => (
    latestDaemonVersion
      ? eligibleDaemonUpdateMachines(machines.machines, latestDaemonVersion)
      : []
  ), [latestDaemonVersion, machines.machines])
  const eligibleMachineIds = useMemo(
    () => eligibleMachines.map((machine) => machine.id),
    [eligibleMachines],
  )
  useLayoutEffect(() => {
    const eligible = new Set(eligibleMachineIds)
    for (const id of batchRef.current?.machineIds ?? []) {
      if (!eligible.has(id)) batchRef.current?.machineIds.delete(id)
    }
  }, [eligibleMachineIds])
  const updateScope = useMemo(() => ({ registry: origin.registry, userId, latestDaemonVersion }), [origin.registry, userId, latestDaemonVersion])
  const previousScope = useRef(updateScope)
  useEffect(() => {
    if (previousScope.current === updateScope) return
    previousScope.current = updateScope
    dispatch({ type: "update.clear" })
  }, [dispatch, updateScope])
  const update = extensionState.update

  useEffect(() => {
    if (!latestDaemonVersion || !parseReleaseVersion(latestDaemonVersion)) return
    if (!machines.isSuccess) return
    if (eligibleMachineIds.length === 0) {
      writeCollapsed(userId, latestDaemonVersion, false)
      dispatch({ type: "update.clear" })
      return
    }
    if (!update) {
      dispatch({
        type: "update.sync",
        collapsed: readCollapsed(userId, latestDaemonVersion),
        eligibleMachineIds,
      })
      return
    }
    dispatch({ type: "update.eligibility", eligibleMachineIds })
  }, [dispatch, eligibleMachineIds, latestDaemonVersion, machines.isSuccess, update, userId])

  const collapse = useCallback(() => {
    if (!latestDaemonVersion || !extensionState.update) return
    writeCollapsed(userId, latestDaemonVersion, true)
    dispatch({ type: "update.collapse" })
  }, [dispatch, extensionState.update, latestDaemonVersion, userId])

  const open = useCallback(() => {
    if (!latestDaemonVersion || !extensionState.update) return
    writeCollapsed(userId, latestDaemonVersion, false)
    dispatch({ type: "update.open" })
  }, [dispatch, extensionState.update, latestDaemonVersion, userId])

  const request = useCallback(async () => {
    const current = extensionState.update
    if (!current || current.pendingMachineIds.length > 0) return
    const machineIds = daemonUpdateRequestMachineIds(current, eligibleMachineIds)
    if (machineIds.length === 0) return
    const token = origin.begin().token
    const authentication = origin.registry!.authenticationView.get()
    origin.assertOwner(token)
    const batch = { machineIds: new Set(machineIds) }
    batchRef.current = batch
    dispatch({ type: "update.dispatch", machineIds })
    const result = await dispatchMachineUpdateRequests(machineIds, requestUpdate)
    try { origin.assertOwner(token) } catch { return }
    const currentAuthentication = origin.registry!.authenticationView.get()
    if (!currentAuthentication.active || currentAuthentication.generation !== authentication.generation) return
    if (batchRef.current !== batch) return
    const pending = batch.machineIds
    result.acceptedMachineIds = result.acceptedMachineIds.filter((id) => pending.has(id))
    result.failedMachineIds = result.failedMachineIds.filter((id) => pending.has(id))
    for (const machineId of result.failedMachineIds) {
      log.warn("daemon update request failed", { machineId })
    }
    dispatch({ type: "update.settle", ...result })
  }, [dispatch, eligibleMachineIds, extensionState.update, requestUpdate, origin])

  return {
    eligibleMachines,
    eligibleMachineIds,
    update,
    collapse,
    open,
    request,
  }
}
