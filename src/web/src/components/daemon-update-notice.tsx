"use client"

import { useCallback, useEffect, useRef, type ComponentPropsWithoutRef } from "react"
import Image from "next/image"
import { useQueryClient } from "@tanstack/react-query"
import {
  SELF_UPDATE_MIN_DAEMON_VERSION,
  isPresenceOnline,
  parseReleaseVersion,
  releaseVersionGte,
} from "@alook/shared"
import { machinesQueryFn, type MachineSummary } from "@/hooks/community/use-machines"
import { messageNotification } from "@/components/ui/toast"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { tid } from "@/lib/community/testids"
import { log } from "@/lib/logger"

const STORAGE_KEY_PREFIX = "alook:daemon-update-check"
const pendingMachineChecks = new Map<string, ReturnType<typeof machinesQueryFn>>()

export function daemonUpdateStorageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}:${userId}`
}

export function eligibleDaemonUpdateMachines<T extends Pick<MachineSummary, "id" | "status" | "daemonVersion">>(
  machines: readonly T[],
  latestDaemonVersion: string,
): T[] {
  if (!parseReleaseVersion(latestDaemonVersion)) return []
  return machines.filter((machine) => {
    const currentVersion = machine.daemonVersion
    if (!isPresenceOnline(machine.status) || !currentVersion || !parseReleaseVersion(currentVersion)) {
      return false
    }
    return releaseVersionGte(currentVersion, SELF_UPDATE_MIN_DAEMON_VERSION)
      && !releaseVersionGte(currentVersion, latestDaemonVersion)
  })
}

type MachineUpdateRequester = (machineId: string) => Promise<unknown>

async function requestMachineUpdate(machineId: string): Promise<void> {
  await apiFetch<{ dispatched: true }>(`/api/community/machines/${machineId}/update`, {
    method: "POST",
  })
}

export async function dispatchDaemonUpdates(
  machines: readonly Pick<MachineSummary, "id">[],
  requestUpdate: MachineUpdateRequester = requestMachineUpdate,
): Promise<void> {
  await Promise.all(machines.map(async (machine) => {
    try {
      await requestUpdate(machine.id)
    } catch (error) {
      log.warn("daemon update notification dispatch failed", {
        machineId: machine.id,
        error: String(error),
      })
    }
  }))
}

function readCheckedWebVersion(userId: string): string | null {
  try {
    return window.localStorage.getItem(daemonUpdateStorageKey(userId))
  } catch {
    return null
  }
}

function writeCheckedWebVersion(userId: string, webVersion: string): void {
  try {
    window.localStorage.setItem(daemonUpdateStorageKey(userId), webVersion)
  } catch {}
}

type MachinesLoader = typeof machinesQueryFn

function fetchMachinesOnce(
  checkKey: string,
  loadMachines: MachinesLoader,
): ReturnType<typeof machinesQueryFn> {
  const pending = pendingMachineChecks.get(checkKey)
  if (pending) return pending

  const request = loadMachines().finally(() => {
    if (pendingMachineChecks.get(checkKey) === request) pendingMachineChecks.delete(checkKey)
  })
  pendingMachineChecks.set(checkKey, request)
  return request
}

export function DaemonUpdateNotice({
  userId,
  webVersion = process.env.NEXT_PUBLIC_APP_VERSION,
  latestDaemonVersion = process.env.NEXT_PUBLIC_LATEST_DAEMON_VERSION,
  loadMachines = machinesQueryFn,
  requestUpdate = requestMachineUpdate,
}: {
  userId: string
  webVersion?: string
  latestDaemonVersion?: string
  loadMachines?: MachinesLoader
  requestUpdate?: MachineUpdateRequester
}) {
  const startedCheck = useRef<string | null>(null)

  useEffect(() => {
    if (!webVersion || !latestDaemonVersion) return
    if (!parseReleaseVersion(webVersion) || !parseReleaseVersion(latestDaemonVersion)) return
    const checkKey = `${userId}:${webVersion}:${latestDaemonVersion}`
    if (startedCheck.current === checkKey) return
    startedCheck.current = checkKey
    if (readCheckedWebVersion(userId) === webVersion) return

    let active = true
    void fetchMachinesOnce(checkKey, loadMachines)
      .then(({ machines }) => {
        if (!active) return
        const eligible = eligibleDaemonUpdateMachines(machines, latestDaemonVersion)
        if (eligible.length === 0) {
          writeCheckedWebVersion(userId, webVersion)
          return
        }
        let dispatched = false
        const notificationId = messageNotification.add({
          id: `daemon-update:${userId}:${webVersion}`,
          title: "Machine update available",
          description: "You can update your machine to get more features.",
          type: "warning",
          timeout: 0,
          data: {
            closeLabel: "Hide until the next Web update",
            bareIcon: true,
            icon: <Image src="/alook.svg" alt="" width={32} height={32} className="size-8" />,
            testId: tid.daemonUpdateNotice,
          },
          actionProps: {
            children: "Update",
            "data-testid": tid.daemonUpdateAction,
            onClick: () => {
              if (dispatched) return
              dispatched = true
              writeCheckedWebVersion(userId, webVersion)
              messageNotification.close(notificationId)
              void dispatchDaemonUpdates(eligible, requestUpdate)
            },
          } as ComponentPropsWithoutRef<"button">,
          onClose: () => writeCheckedWebVersion(userId, webVersion),
        })
      })
      .catch(() => {})

    return () => {
      active = false
      if (startedCheck.current === checkKey) startedCheck.current = null
    }
  }, [latestDaemonVersion, loadMachines, requestUpdate, userId, webVersion])

  return null
}

export function CommunityDaemonUpdateNotice({ userId }: { userId: string }) {
  const queryClient = useQueryClient()
  const loadMachines = useCallback(
    () => queryClient.fetchQuery({
      queryKey: communityKeys.machines(),
      queryFn: machinesQueryFn,
    }),
    [queryClient],
  )

  return <DaemonUpdateNotice userId={userId} loadMachines={loadMachines} />
}
