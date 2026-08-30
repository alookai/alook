import React from "react"
import { readFileSync } from "node:fs"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  machinesQueryFn: vi.fn(),
  notificationAdd: vi.fn(),
  notificationClose: vi.fn(),
  routerPush: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}))

vi.mock("@/hooks/community/use-machines", () => ({
  machinesQueryFn: mocks.machinesQueryFn,
}))

vi.mock("@/components/ui/toast", () => ({
  messageNotification: {
    add: mocks.notificationAdd,
    close: mocks.notificationClose,
  },
}))

import {
  DaemonUpdateNotice,
  daemonUpdateStorageKey,
  outdatedDaemonMachines,
} from "./daemon-update-notice"

const values = new Map<string, string>()
const localStorage = {
  getItem: vi.fn((key: string) => values.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => values.set(key, value)),
}

function machine(daemonVersion: string) {
  return { daemonVersion }
}

async function renderNotice() {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(DaemonUpdateNotice, {
        userId: "user-1",
        webVersion: "0.1.27",
        latestDaemonVersion: "0.1.27",
      }),
    )
  })
  return renderer
}

describe("DaemonUpdateNotice", () => {
  beforeEach(() => {
    values.clear()
    localStorage.getItem.mockReset()
    localStorage.getItem.mockImplementation((key: string) => values.get(key) ?? null)
    localStorage.setItem.mockReset()
    localStorage.setItem.mockImplementation((key: string, value: string) => values.set(key, value))
    mocks.machinesQueryFn.mockReset()
    mocks.notificationAdd.mockReset()
    mocks.notificationAdd.mockReturnValue("toast-1")
    mocks.notificationClose.mockReset()
    mocks.routerPush.mockReset()
    vi.stubGlobal("window", { localStorage })
  })

  it("uses the release daemon package as the Web build target", () => {
    const config = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8")
    expect(config).toContain('path.resolve(__dirname, "../daemon/package.json")')
    expect(config).toContain("NEXT_PUBLIC_LATEST_DAEMON_VERSION: daemonPkg.version")
  })

  it("selects only valid daemon releases below the injected target", () => {
    expect(outdatedDaemonMachines([
      machine("0.1.26"),
      machine("0.1.27"),
      machine("0.1.28"),
      machine(""),
      machine("dev"),
    ], "0.1.27")).toEqual([machine("0.1.26")])
    expect(outdatedDaemonMachines([machine("0.1.26")], "latest")).toEqual([])
  })

  it("records the current Web version after one successful all-current query", async () => {
    mocks.machinesQueryFn.mockResolvedValue({ machines: [machine("0.1.27"), machine("")] })
    await renderNotice()

    expect(mocks.machinesQueryFn).toHaveBeenCalledOnce()
    expect(localStorage.setItem).toHaveBeenCalledWith(
      daemonUpdateStorageKey("user-1"),
      "0.1.27",
    )
    expect(mocks.notificationAdd).not.toHaveBeenCalled()
  })

  it("skips the query when this user already checked the current Web version", async () => {
    values.set(daemonUpdateStorageKey("user-1"), "0.1.27")
    await renderNotice()

    expect(mocks.machinesQueryFn).not.toHaveBeenCalled()
    expect(mocks.notificationAdd).not.toHaveBeenCalled()
  })

  it("checks again when the stored flag belongs to an older Web version", async () => {
    values.set(daemonUpdateStorageKey("user-1"), "0.1.26")
    mocks.machinesQueryFn.mockResolvedValue({ machines: [machine("0.1.26")] })
    await renderNotice()

    expect(mocks.machinesQueryFn).toHaveBeenCalledOnce()
    expect(mocks.notificationAdd).toHaveBeenCalledOnce()
  })

  it("shows one thin notification for outdated machines without recording early", async () => {
    mocks.machinesQueryFn.mockResolvedValue({
      machines: [machine("0.1.26"), machine("0.1.20"), machine("unknown")],
    })
    await renderNotice()
    const notice = mocks.notificationAdd.mock.calls[0]![0]

    expect(notice.title).toBe("Daemon update available")
    expect(notice.description).toContain("2 machines are running an older daemon")
    expect(notice.description).toContain("v0.1.27")
    expect(notice.data.closeLabel).toBe("Hide until the next Web update")
    expect(notice.timeout).toBe(0)
    expect(localStorage.setItem).not.toHaveBeenCalled()
  })

  it("retries the canceled development pass under React Strict Mode", async () => {
    mocks.machinesQueryFn.mockResolvedValue({ machines: [machine("0.1.26")] })

    await act(async () => {
      TestRenderer.create(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(DaemonUpdateNotice, {
            userId: "user-1",
            webVersion: "0.1.27",
            latestDaemonVersion: "0.1.27",
          }),
        ),
      )
    })

    expect(mocks.machinesQueryFn).toHaveBeenCalledOnce()
    expect(mocks.notificationAdd).toHaveBeenCalledOnce()
  })

  it("records dismissal and routes the action to Machines", async () => {
    mocks.machinesQueryFn.mockResolvedValue({ machines: [machine("0.1.26")] })
    await renderNotice()
    const notice = mocks.notificationAdd.mock.calls[0]![0]

    act(() => notice.actionProps.onClick())
    expect(mocks.routerPush).toHaveBeenCalledWith("/c/me/machines")
    expect(mocks.notificationClose).toHaveBeenCalledWith("toast-1")

    act(() => notice.onClose())
    expect(localStorage.setItem).toHaveBeenCalledWith(
      daemonUpdateStorageKey("user-1"),
      "0.1.27",
    )
  })

  it("keeps request failures retryable", async () => {
    mocks.machinesQueryFn.mockRejectedValue(new Error("offline"))
    await renderNotice()

    expect(localStorage.setItem).not.toHaveBeenCalled()
    expect(mocks.notificationAdd).not.toHaveBeenCalled()
  })

  it("fails open when local storage is unavailable", async () => {
    localStorage.getItem.mockImplementationOnce(() => {
      throw new Error("storage disabled")
    })
    localStorage.setItem.mockImplementationOnce(() => {
      throw new Error("storage disabled")
    })
    mocks.machinesQueryFn.mockResolvedValue({ machines: [machine("0.1.27")] })

    await expect(renderNotice()).resolves.toBeDefined()
    expect(mocks.machinesQueryFn).toHaveBeenCalledOnce()
    expect(mocks.notificationAdd).not.toHaveBeenCalled()
  })

  it("mounts the thin controller only in authenticated route groups", () => {
    const appLayout = readFileSync(new URL("../app/(app)/layout.tsx", import.meta.url), "utf8")
    const communityShell = readFileSync(new URL("../app/c/community-shell.tsx", import.meta.url), "utf8")
    expect(appLayout).toContain("<DaemonUpdateNotice userId={session.user.id} />")
    expect(communityShell).toContain("<CommunityDaemonUpdateNotice userId={currentUser.id} />")
  })
})
