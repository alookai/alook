import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import { get, set } from "idb-keyval"
import { openDB } from "idb"
import { cloneElement, createElement, type PropsWithChildren, type ReactElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { NavUser } from "./nav-user"
import { ApplicationQueryProvider, useApplicationOwner, type ApplicationOwner } from "@/lib/application-owner"
import { clearAllPersistedCaches, createIdbPersister } from "@/lib/query-persister"
let owner: ApplicationOwner
function OwnerProbe() { const value = useApplicationOwner(); useLayoutEffect(() => { owner = value }); return createElement(NavUser) }
function App({ userId = "user_1" }: { userId?: string }) { return createElement(ApplicationQueryProvider, { userId }, createElement(OwnerProbe)) }

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  signOut: vi.fn(),
  toastError: vi.fn(),
  session: {
    data: {
      user: {
        id: "user_1",
        name: "Ada",
        discriminator: "0042",
        email: "ada@example.com",
        image: "https://cdn.example.com/ada.png",
      },
    },
    isPending: false,
  },
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.routerPush }) }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = {
  useSession: () => mocks.session,
  signOut: (...args: unknown[]) => mocks.signOut(...args),
}; return { ...sessionSDK, signOutWithOrigin: async (assertActive: () => void, ...args: unknown[]) => { assertActive(); return sessionSDK.signOut(...args) }, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }))
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: PropsWithChildren) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: PropsWithChildren) => createElement("div", null, children),
  DropdownMenuGroup: ({ children }: PropsWithChildren) => createElement("div", null, children),
  DropdownMenuItem: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) =>
    createElement("button", props, children),
  DropdownMenuLabel: ({ children }: PropsWithChildren) => createElement("div", null, children),
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuTrigger: ({ children, render: trigger }:
    PropsWithChildren<{ render: ReactElement }>) => cloneElement(trigger, {}, children),
}))

describe("NavUser avatar", () => {
  it("uses the session photo in both the trigger and open menu identity", async () => {
    render(createElement(App))

    await waitFor(() => expect(screen.getByTestId("nav-user-trigger")).toBeVisible())
    const triggerAvatar = screen.getByTestId("nav-user-trigger-avatar")
    const menuAvatar = screen.getByTestId("nav-user-menu-avatar")
    for (const avatar of [triggerAvatar, menuAvatar]) {
      expect(avatar).toHaveAttribute("data-avatar-kind", "photo")
      expect(avatar).toHaveStyle({ width: "28px", height: "28px" })
    }
    expect(screen.getByTestId("nav-user-trigger"))
      .toHaveAttribute("aria-label", "Open user menu for Ada")
    expect(renderedPhotos()).toEqual([
      "https://cdn.example.com/ada.png",
      "https://cdn.example.com/ada.png",
    ])
  })
})

function renderedPhotos(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLImageElement>('[data-remote-image-kind="identity"]'),
    (image) => image.src,
  )
}

beforeEach(async () => {
  await act(async () => { await clearAllPersistedCaches(); }) ; mocks.routerPush.mockClear(); mocks.toastError.mockClear(); mocks.signOut.mockReset(); mocks.session.data.user.id = "user_1"
})
afterEach(() => owner?.queryClient.clear())
describe("actual NavUser native logout", () => {
  it("confirmed SDK sign-out clears original native facts and both disk domains then navigates", async () => {
    mocks.signOut.mockImplementation(async (options) => { options.fetchOptions.onRequest(); options.fetchOptions.onSuccess(); return { data: { success: true } } })
    render(createElement(App)); await waitFor(() => expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy())
    const community = createIdbPersister("user_1"), application = createIdbPersister("user_1", "application")
    const payload = { timestamp: Date.now(), buster: "v3", clientState: { queries: [], mutations: [] } }
    await act(async () => { await community.persistClient(payload); }) ; await act(async () => { await application.persistClient(payload) })
    for (const version of ["v1", "v2", "v3", "v99"]) {
      await act(async () => { await set(`alook:qc:${version}:user_1:client`, "original A") })
      await act(async () => { await set(`alook:qc:${version}:B:client`, "unrelated B") })
      await act(async () => { await set(`alook:qc:${version}:user_1:application:client`, "original application A") })
      await act(async () => { await set(`alook:qc:${version}:B:application:client`, "unrelated application B") })
    }
    const legacy = await openDB("alook-chat-cache-logout-boundary", 4, { upgrade(db) { db.createObjectStore("messages") } }); await legacy.put("messages", { text: "unqualified workspace" }, "m"); legacy.close()
    act(() => owner.queryClient.setQueryData(["original"], { private: "A" }))
    fireEvent.click(screen.getByRole("button", { name: "Log out" })); await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/sign-in"))
    expect(owner.lifecycle.get().active).toBe(false); expect(owner.queryClient.getQueryData(["original"])).toBeUndefined()
    expect(await community.isCurrent()).toBe(false); expect(await application.isCurrent()).toBe(false); expect(mocks.toastError).not.toHaveBeenCalled()
    for (const version of ["v1", "v2", "v3", "v99"]) {
      expect(await get(`alook:qc:${version}:user_1:client`)).toBeUndefined()
      expect(await get(`alook:qc:${version}:user_1:application:client`)).toBeUndefined()
      expect(await get(`alook:qc:${version}:B:client`)).toBe("unrelated B")
      expect(await get(`alook:qc:${version}:B:application:client`)).toBe("unrelated application B")
    }
    expect((await indexedDB.databases()).map((database) => database.name)).toContain("alook-chat-cache-logout-boundary")
  })
  it("current SDK failure preserves facts and reports the failure", async () => {
    mocks.signOut.mockResolvedValue({ error: { message: "Cannot log out" } })
    render(createElement(App)); await waitFor(() => expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy()); act(() => owner.queryClient.setQueryData(["original"], { private: "A" }))
    fireEvent.click(screen.getByRole("button", { name: "Log out" })); await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Cannot log out"))
    expect(owner.lifecycle.get().active).toBe(true); expect(owner.queryClient.getQueryData(["original"])).toEqual({ private: "A" }); expect(mocks.routerPush).not.toHaveBeenCalled()
  })
  it("confirmed SDK sign-out still navigates when original disk retirement rejects", async () => {
    const failure = new DOMException("IDB unavailable", "UnknownError")
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      mocks.signOut.mockImplementation(async (options) => { options.fetchOptions.onRequest(); options.fetchOptions.onSuccess(); return { data: { success: true } } })
      render(createElement(App))
      await waitFor(() => expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy())
      const original = owner
      vi.spyOn(original, "retireDisk").mockRejectedValueOnce(failure)
      act(() => original.queryClient.setQueryData(["original"], { private: "A" }))
      fireEvent.click(screen.getByRole("button", { name: "Log out" }))
      await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/sign-in"))
      expect(mocks.routerPush).toHaveBeenCalledTimes(1)
      expect(original.lifecycle.get().active).toBe(false)
      expect(original.queryClient.getQueryData(["original"])).toBeUndefined()
      expect(diagnostic).toHaveBeenCalledWith("Application disk cache retirement failed", failure)
      expect(mocks.toastError).not.toHaveBeenCalled()
    } finally { diagnostic.mockRestore() }
  })
  it("a held original disk rejection after switching viewer leaves B quiet", async () => {
    const failure = new DOMException("Original IDB unavailable", "UnknownError")
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      mocks.signOut.mockImplementation(async (options) => { options.fetchOptions.onRequest(); options.fetchOptions.onSuccess(); return { data: { success: true } } })
      const mounted = render(createElement(App))
      await waitFor(() => expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy())
      const original = owner
      let reject!: (reason: unknown) => void
      vi.spyOn(original, "retireDisk").mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
      fireEvent.click(screen.getByRole("button", { name: "Log out" }))
      await waitFor(() => expect(reject).toBeTypeOf("function"))
      mocks.session.data.user.id = "B"
      act(() => mounted.rerender(createElement(App, { userId: "B" })))
      await waitFor(() => expect(owner.userId).toBe("B"))
      act(() => owner.queryClient.setQueryData(["current"], { private: "B" }))
      await act(async () => reject(failure))
      expect(diagnostic).toHaveBeenCalledWith("Application disk cache retirement failed", failure)
      expect(owner.lifecycle.get().active).toBe(true)
      expect(owner.queryClient.getQueryData(["current"])).toEqual({ private: "B" })
      expect(mocks.routerPush).not.toHaveBeenCalled()
      expect(mocks.toastError).not.toHaveBeenCalled()
    } finally { diagnostic.mockRestore() }
  })
  it.each(["success", "failure"])("held old SDK %s after account switch leaves B quiet", async (kind) => {
    let settle!: (result: unknown) => void; let signal!: AbortSignal
    mocks.signOut.mockImplementation((options) => {
      options.fetchOptions.onRequest(); signal = options.fetchOptions.signal
      return new Promise((resolve) => { settle = resolve }).then((result) => { if (kind === "success") options.fetchOptions.onSuccess(); return result })
    })
    const mounted = render(createElement(App)); await waitFor(() => expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Log out" })); await waitFor(() => expect(settle).toBeTypeOf("function")); mocks.session.data.user.id = "B"
    act(() => mounted.rerender(createElement(App, { userId: "B" }))); await waitFor(() => expect(owner.userId).toBe("B")); act(() => owner.queryClient.setQueryData(["current"], { private: "B" }))
    await act(async () => settle(kind === "success" ? { data: { success: true } } : { error: { message: "old failure" } }))
    expect(signal.aborted).toBe(true); expect(owner.lifecycle.get().active).toBe(true); expect(owner.queryClient.getQueryData(["current"])).toEqual({ private: "B" }); expect(mocks.routerPush).not.toHaveBeenCalled(); expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
