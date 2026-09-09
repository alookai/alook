import { StrictMode, createElement } from "react"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  machinesQueryFn: vi.fn(),
  notificationAdd: vi.fn(),
  notificationClose: vi.fn(),
  requestUpdate: vi.fn(),
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
  dispatchDaemonUpdates,
  eligibleDaemonUpdateMachines,
} from "./daemon-update-notice"

const storageGetItem = vi.spyOn(Storage.prototype, "getItem")
const storageSetItem = vi.spyOn(Storage.prototype, "setItem")
const webRoot = existsSync(resolve(process.cwd(), "next.config.ts"))
  ? process.cwd()
  : resolve(process.cwd(), "src/web")

function machine(
  daemonVersion: string,
  overrides: { id?: string; status?: "online" | "offline" } = {},
) {
  return {
    id: overrides.id ?? `machine-${daemonVersion}`,
    status: overrides.status ?? "online",
    daemonVersion,
  }
}

async function renderNotice() {
  const rendered = render(createElement(DaemonUpdateNotice, {
    userId: "user-1",
    webVersion: "0.1.27",
    latestDaemonVersion: "0.1.27",
    requestUpdate: mocks.requestUpdate,
  }))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return rendered
}

describe("DaemonUpdateNotice", () => {
  beforeEach(() => {
    window.localStorage.clear()
    storageGetItem.mockClear()
    storageSetItem.mockClear()
    mocks.machinesQueryFn.mockReset()
    mocks.notificationAdd.mockReset()
    mocks.notificationAdd.mockReturnValue("toast-1")
    mocks.notificationClose.mockReset()
    mocks.requestUpdate.mockReset()
    mocks.requestUpdate.mockResolvedValue({ dispatched: true })
  })

  afterAll(() => {
    storageGetItem.mockRestore()
    storageSetItem.mockRestore()
  })

  it("uses the release daemon package as the Web build target", () => {
    const config = readFileSync(resolve(webRoot, "next.config.ts"), "utf8")
    expect(config).toContain('path.resolve(__dirname, "../daemon/package.json")')
    expect(config).toContain("NEXT_PUBLIC_LATEST_DAEMON_VERSION: daemonPkg.version")
  })

  it("selects only online, remotely updateable daemon releases below the target", () => {
    expect(eligibleDaemonUpdateMachines([
      machine("0.1.26"),
      machine("0.1.27"),
      machine("0.1.28"),
      machine("0.1.26", { id: "offline", status: "offline" }),
      machine("0.1.6", { id: "manual-update-only" }),
      machine(""),
      machine("dev"),
    ], "0.1.27")).toEqual([machine("0.1.26")])
    expect(eligibleDaemonUpdateMachines([machine("0.1.26")], "latest")).toEqual([])
  })

  it("records the current Web version after one successful all-current query", async () => {
    mocks.machinesQueryFn.mockResolvedValue({ machines: [machine("0.1.27"), machine("")] })
    await renderNotice()

    expect(mocks.machinesQueryFn).toHaveBeenCalledOnce()
    expect(storageSetItem).toHaveBeenCalledWith(
      daemonUpdateStorageKey("user-1"),
      "0.1.27",
    )
    expect(mocks.notificationAdd).not.toHaveBeenCalled()
  })

  it("skips the query when this user already checked the current Web version", async () => {
    window.localStorage.setItem(daemonUpdateStorageKey("user-1"), "0.1.27")
    storageSetItem.mockClear()
    await renderNotice()

    expect(mocks.machinesQueryFn).not.toHaveBeenCalled()
    expect(mocks.notificationAdd).not.toHaveBeenCalled()
  })

  it("checks again when the stored flag belongs to an older Web version", async () => {
    window.localStorage.setItem(daemonUpdateStorageKey("user-1"), "0.1.26")
    storageSetItem.mockClear()
    mocks.machinesQueryFn.mockResolvedValue({ machines: [machine("0.1.26")] })
    await renderNotice()

    expect(mocks.machinesQueryFn).toHaveBeenCalledOnce()
    expect(mocks.notificationAdd).toHaveBeenCalledOnce()
  })

  it("shows the exact one-click update notification without recording early", async () => {
    mocks.machinesQueryFn.mockResolvedValue({
      machines: [machine("0.1.26")],
    })
    await renderNotice()
    const notice = mocks.notificationAdd.mock.calls[0]![0]

    expect(notice.title).toBe("Machine update available")
    expect(notice.description).toBe("You can update your machine to get more features.")
    expect(notice.actionProps.children).toBe("Update")
    expect(notice.data.closeLabel).toBe("Hide until the next Web update")
    expect(notice.data.bareIcon).toBe(true)
    expect(notice.data.icon.props).toMatchObject({
      src: "/alook.svg",
      alt: "",
      width: 32,
      height: 32,
    })
    expect(notice.timeout).toBe(0)
    expect(storageSetItem).not.toHaveBeenCalled()
  })

  it("uses plural copy when multiple machines can update", async () => {
    mocks.machinesQueryFn.mockResolvedValue({
      machines: [machine("0.1.26"), machine("0.1.20")],
    })
    await renderNotice()

    expect(mocks.notificationAdd.mock.calls[0]![0].description)
      .toBe("You can update your machines to get more features.")
  })

  it("retries the canceled development pass under React Strict Mode", async () => {
    mocks.machinesQueryFn.mockResolvedValue({ machines: [machine("0.1.26")] })

    render(createElement(
      StrictMode,
      null,
      createElement(DaemonUpdateNotice, {
        userId: "user-1",
        webVersion: "0.1.27",
        latestDaemonVersion: "0.1.27",
        requestUpdate: mocks.requestUpdate,
      }),
    ))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.machinesQueryFn).toHaveBeenCalledOnce()
    expect(mocks.notificationAdd).toHaveBeenCalledOnce()
  })

  it("closes immediately, records handling, and dispatches every eligible machine once", async () => {
    mocks.machinesQueryFn.mockResolvedValue({
      machines: [
        machine("0.1.26", { id: "eligible-1" }),
        machine("0.1.20", { id: "eligible-2" }),
        machine("0.1.26", { id: "offline", status: "offline" }),
        machine("0.1.6", { id: "manual-update-only" }),
      ],
    })
    await renderNotice()
    const notice = mocks.notificationAdd.mock.calls[0]![0]

    act(() => notice.actionProps.onClick())
    act(() => notice.actionProps.onClick())
    expect(mocks.notificationClose).toHaveBeenCalledWith("toast-1")
    expect(storageSetItem).toHaveBeenCalledWith(
      daemonUpdateStorageKey("user-1"),
      "0.1.27",
    )
    expect(mocks.requestUpdate.mock.calls).toEqual([
      ["eligible-1"],
      ["eligible-2"],
    ])
  })

  it("absorbs background dispatch failures", async () => {
    const requestUpdate = vi.fn().mockRejectedValue(new Error("offline race"))

    await expect(dispatchDaemonUpdates(
      [{ id: "machine-1" }],
      requestUpdate,
    )).resolves.toBeUndefined()
  })

  it("keeps request failures retryable", async () => {
    mocks.machinesQueryFn.mockRejectedValue(new Error("offline"))
    await renderNotice()

    expect(storageSetItem).not.toHaveBeenCalled()
    expect(mocks.notificationAdd).not.toHaveBeenCalled()
  })

  it("fails open when local storage is unavailable", async () => {
    storageGetItem.mockImplementationOnce(() => {
      throw new Error("storage disabled")
    })
    storageSetItem.mockImplementationOnce(() => {
      throw new Error("storage disabled")
    })
    mocks.machinesQueryFn.mockResolvedValue({ machines: [machine("0.1.27")] })

    await expect(renderNotice()).resolves.toBeDefined()
    expect(mocks.machinesQueryFn).toHaveBeenCalledOnce()
    expect(mocks.notificationAdd).not.toHaveBeenCalled()
  })

  it("keeps the legacy notice outside Community while Community owns its shell surface", () => {
    const appLayout = readFileSync(resolve(webRoot, "src/app/(app)/layout.tsx"), "utf8")
    const communityShell = readFileSync(resolve(webRoot, "src/app/c/community-shell.tsx"), "utf8")
    const shellFrame = readFileSync(resolve(
      webRoot,
      "src/components/community/shell/shell-frame.tsx",
    ), "utf8")
    expect(appLayout).toContain("<DaemonUpdateNotice userId={session.user.id} />")
    expect(communityShell).not.toContain("DaemonUpdateNotice")
    expect(shellFrame).toContain("useShellDaemonUpdateController")
  })
})
