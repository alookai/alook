import "fake-indexeddb/auto"
import { useLayoutEffect } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"

const backend = vi.hoisted(() => { const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); return fetch })
import { get } from "idb-keyval"
import { clearAllPersistedCaches, createIdbPersister } from "./query-persister"
import { authClient, currentSessionViewer, useSession } from "./auth-session"
let mounted: ReturnType<typeof render> | undefined
afterEach(async () => {
  mounted?.unmount()
  await new Promise(resolve => setTimeout(resolve, 1100))
  await clearAllPersistedCaches()
  vi.unstubAllGlobals()
})

it("uses the real SDK reconnect owner after cold network failure and distinguishes network errors from rejected sessions", async () => {
  let mode: "offline" | "valid" | "forbidden" | "unauthorized" = "offline"
  const now = new Date().toISOString()
  backend.mockImplementation(async () => {
    if (mode === "offline") throw new TypeError("Offline")
    if (mode === "forbidden") return Response.json({ message: "Rejected" }, { status: 403 })
    if (mode === "unauthorized") return Response.json({ message: "Rejected" }, { status: 401 })
    return Response.json({ user: { id: "viewer", name: "Viewer", email: "viewer@example.test", emailVerified: true, createdAt: now, updatedAt: now },
      session: { id: "session", token: "fixture", userId: "viewer", expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: now, updatedAt: now } })
  })
  let refetch!: () => Promise<void>
  function Probe() {
    const session = useSession()
    useLayoutEffect(() => { refetch = session.refetch }, [session.refetch])
    return <output>{session.isPending ? "pending" : session.error ? "unverified" : "confirmed"}</output>
  }
  const owner = createIdbPersister("viewer")
  await owner.rememberAccountIdentity({ id: "viewer", email: "viewer@example.test" }, () => undefined)
  mounted = render(<Probe />)
  await waitFor(() => expect(mounted!.getByText("unverified")).toBeInTheDocument())
  expect(currentSessionViewer()).toBeUndefined()
  expect(await owner.isCurrent()).toBe(true)
  mode = "valid"
  fireEvent(window, new Event("online"))
  await waitFor(() => expect(currentSessionViewer()).toBe("viewer"))
  expect(await owner.isCurrent()).toBe(true)
  mode = "offline"
  await act(async () => refetch())
  expect(currentSessionViewer()).toBeUndefined()
  expect(authClient.$store.atoms.session.get().data?.user.id).toBe("viewer")
  expect(await owner.isCurrent()).toBe(true)
  mode = "forbidden"
  await act(async () => refetch())
  expect(currentSessionViewer()).toBeNull()
  expect(authClient.$store.atoms.session.get().data?.user.id).toBe("viewer")
  expect(await owner.isCurrent()).toBe(false)
  mode = "unauthorized"
  await act(async () => refetch())
  expect(currentSessionViewer()).toBeNull()
  expect(authClient.$store.atoms.session.get().data).toBeNull()
})


it.each(["other-account", "new-owner", "account-confirmation"])("a late session result retires only its captured account epochs (%s)", async kind => {
  const old = createIdbPersister("old-a")
  await old.rememberAccountIdentity({ id: "old-a", email: "a@example.test" }, () => undefined)
  let release!: (response: Response) => void
  backend.mockImplementation(() => new Promise<Response>(resolve => { release = resolve }))
  function Probe() { useSession(); return <output>Account check</output> }
  mounted = render(<Probe />)
  await waitFor(() => expect(release).toBeTypeOf("function"))
  if (kind === "new-owner") await old.retireAccount()
  const newId = kind === "new-owner" ? "old-a" : "new-b"
  const newer = createIdbPersister(newId)
  await newer.rememberAccountIdentity({ id: newId, email: "new@example.test" }, () => undefined)
  const currentDescriptor = await get("alook:qc:last-account")
  const now = new Date().toISOString()
  await act(async () => { release(Response.json(kind === "account-confirmation" ? {
    user: { id: newId, name: "New viewer", email: "new@example.test", emailVerified: true, createdAt: now, updatedAt: now },
    session: { id: "new-session", token: "fixture", userId: newId, expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: now, updatedAt: now },
  } : null)) })
  await waitFor(() => expect(currentSessionViewer()).toBe(kind === "account-confirmation" ? newId : null))
  expect(await newer.isCurrent()).toBe(true)
  expect(await get("alook:qc:last-account")).toEqual(currentDescriptor)
  expect(await old.isCurrent()).toBe(false)
})
