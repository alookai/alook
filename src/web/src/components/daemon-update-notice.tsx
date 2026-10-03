"use client"

import { useEffect, useRef, type ComponentPropsWithoutRef } from "react"
import Image from "next/image"
import {
  SELF_UPDATE_MIN_DAEMON_VERSION,
  isPresenceOnline,
  parseReleaseVersion,
  releaseVersionGte,
} from "@alook/shared"
import type { MachinesResponse, MachineSummary } from "@/hooks/community/use-machines"
import { messageNotification } from "@/components/ui/toast"
import { applicationKey, assertApplicationOwner, captureApplicationOwner, runApplicationRequest, useApplicationOwner } from "@/lib/application-owner"
import { apiFetch, type ApiRequestOptions } from "@/lib/api/client"
import { tid } from "@/lib/community/testids"
import { log } from "@/lib/logger"

const STORAGE_KEY_PREFIX = "alook:daemon-update-check"

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

export async function requestMachineUpdate(machineId: string, options?: ApiRequestOptions): Promise<void> {
  await apiFetch<{ dispatched: true }>(`/api/community/machines/${machineId}/update`, {
    ...options, method: "POST",
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

type MachinesLoader = () => Promise<MachinesResponse>

export function DaemonUpdateNotice({
  userId,
  webVersion = process.env.NEXT_PUBLIC_APP_VERSION,
  latestDaemonVersion = process.env.NEXT_PUBLIC_LATEST_DAEMON_VERSION,
  loadMachines,
  requestUpdate,
}: {
  userId: string
  webVersion?: string
  latestDaemonVersion?: string
  loadMachines?: MachinesLoader
  requestUpdate?: MachineUpdateRequester
}) {
  const owner = useApplicationOwner()
  const startedCheck = useRef<string | null>(null)

  useEffect(() => {
    if (!webVersion || !latestDaemonVersion) return
    if (!parseReleaseVersion(webVersion) || !parseReleaseVersion(latestDaemonVersion)) return
    const checkKey = `${userId}:${webVersion}:${latestDaemonVersion}`
    if (startedCheck.current === checkKey) return
    startedCheck.current = checkKey
    if (readCheckedWebVersion(userId) === webVersion) return

    const token = captureApplicationOwner(owner)
    const assertActive = () => assertApplicationOwner(token)
    let active = true
    void owner.queryClient.fetchQuery({
      queryKey: applicationKey(owner, "daemon-update-check", webVersion, latestDaemonVersion),
      staleTime: Infinity,
      queryFn: ({ signal }) => runApplicationRequest(owner, (options) => loadMachines ? loadMachines() : apiFetch<MachinesResponse>("/api/community/machines", options), signal),
    })
      .then(({ machines }) => {
        if (!active) return
        assertActive()
        const eligible = eligibleDaemonUpdateMachines(machines, latestDaemonVersion)
        if (eligible.length === 0) {
          writeCheckedWebVersion(userId, webVersion)
          return
        }
        let dispatched = false
        const notificationId = messageNotification.add({
          id: `daemon-update:${userId}:${webVersion}`,
          title: "Machine update available",
          description: eligible.length === 1
            ? "You can update your machine to get more features."
            : "You can update your machines to get more features.",
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
              try { assertActive() } catch { return }
              if (dispatched) return
              dispatched = true
              writeCheckedWebVersion(userId, webVersion)
              messageNotification.close(notificationId)
              void dispatchDaemonUpdates(eligible, (machineId) => {
                assertActive()
                return runApplicationRequest(owner, (options) => requestUpdate ? requestUpdate(machineId) : requestMachineUpdate(machineId, options))
              })
            },
          } as ComponentPropsWithoutRef<"button">,
          onClose: () => { try { assertActive(); writeCheckedWebVersion(userId, webVersion) } catch {} },
        })
      })
      .catch(() => {})

    return () => {
      active = false
      if (startedCheck.current === checkKey) startedCheck.current = null
    }
  }, [latestDaemonVersion, loadMachines, owner, requestUpdate, userId, webVersion])

  return null
}
