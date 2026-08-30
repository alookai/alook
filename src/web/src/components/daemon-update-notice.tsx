"use client"

import { useCallback, useEffect, useRef, type ComponentPropsWithoutRef } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { CircleArrowUp } from "lucide-react"
import { parseReleaseVersion, releaseVersionGte } from "@alook/shared"
import { machinesQueryFn, type MachineSummary } from "@/hooks/community/use-machines"
import { messageNotification } from "@/components/ui/toast"
import { communityKeys } from "@/lib/query-keys"
import { tid } from "@/lib/community/testids"

const STORAGE_KEY_PREFIX = "alook:daemon-update-check"
const pendingMachineChecks = new Map<string, ReturnType<typeof machinesQueryFn>>()

export function daemonUpdateStorageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}:${userId}`
}

export function outdatedDaemonMachines(
  machines: readonly Pick<MachineSummary, "daemonVersion">[],
  latestDaemonVersion: string,
): Pick<MachineSummary, "daemonVersion">[] {
  if (!parseReleaseVersion(latestDaemonVersion)) return []
  return machines.filter((machine) => {
    const currentVersion = machine.daemonVersion
    if (!currentVersion || !parseReleaseVersion(currentVersion)) return false
    return !releaseVersionGte(currentVersion, latestDaemonVersion)
  })
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
}: {
  userId: string
  webVersion?: string
  latestDaemonVersion?: string
  loadMachines?: MachinesLoader
}) {
  const router = useRouter()
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
        const outdated = outdatedDaemonMachines(machines, latestDaemonVersion)
        if (outdated.length === 0) {
          writeCheckedWebVersion(userId, webVersion)
          return
        }
        const count = outdated.length
        const notificationId = messageNotification.add({
          id: `daemon-update:${userId}:${webVersion}`,
          title: "Daemon update available",
          description: `${count} ${count === 1 ? "machine needs" : "machines need"} daemon v${latestDaemonVersion}.`,
          type: "warning",
          timeout: 0,
          data: {
            closeLabel: "Hide until the next Web update",
            icon: <CircleArrowUp className="size-5" />,
            testId: tid.daemonUpdateNotice,
          },
          actionProps: {
            children: "View machines",
            "data-testid": tid.daemonUpdateViewMachines,
            onClick: () => {
              router.push("/c/me/machines")
              messageNotification.close(notificationId)
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
  }, [latestDaemonVersion, loadMachines, router, userId, webVersion])

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
