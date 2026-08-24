import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"

let refs: Map<string, { current: unknown }> = new Map()
let refCounter = 0
let pendingEffects: Array<() => void> = []
let documentVisibility: DocumentVisibilityState = "visible"
let visibilityListeners = new Set<() => void>()

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const id = `ref-${refCounter++}`
    if (!refs.has(id)) refs.set(id, { current: initial })
    return refs.get(id)!
  },
  useEffect: (fn: () => void, _deps: unknown[]) => {
    pendingEffects.push(fn)
  },
}))

function flushEffects() {
  const effects = pendingEffects
  pendingEffects = []
  for (const effect of effects) effect()
}

function fireDocumentVisibility(state: DocumentVisibilityState) {
  documentVisibility = state
  for (const listener of visibilityListeners) listener()
}

const apiFetchMock = vi.fn(() => Promise.resolve({}))
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

const invalidateQueries = vi.fn()
const setQueryData = vi.fn()
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries, setQueryData }),
}))

async function loadHook() {
  const mod = await import("./use-eager-dm-read")
  return mod.useEagerDmRead
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  refs = new Map()
  refCounter = 0
  pendingEffects = []
  documentVisibility = "visible"
  visibilityListeners = new Set()
  apiFetchMock.mockClear()
  invalidateQueries.mockClear()
  setQueryData.mockClear()
  vi.stubGlobal("document", {
    get visibilityState() {
      return documentVisibility
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === "visibilitychange") visibilityListeners.add(listener)
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "visibilitychange") visibilityListeners.delete(listener)
    },
  })
})

afterEach(() => vi.unstubAllGlobals())

describe("useEagerDmRead — document visibility", () => {
  it("does not PUT or optimistically trim while hidden, then reads exactly once when visible", async () => {
    const useHook = await loadHook()
    documentVisibility = "hidden"
    useHook({ dmId: "dm_hidden", snapshotReady: true })
    flushEffects()
    await settle()

    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(setQueryData).not.toHaveBeenCalled()
    expect(invalidateQueries).not.toHaveBeenCalled()

    fireDocumentVisibility("visible")
    await settle()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/dm_hidden/read", {
      method: "PUT",
    })
    expect(setQueryData).toHaveBeenCalledTimes(1)
    expect(setQueryData.mock.calls[0]?.[0]).toEqual(communityKeys.inboxUnreads())
    const trim = setQueryData.mock.calls[0]?.[1] as (previous: {
      servers: unknown[]
      dms: Array<{ channelId: string }>
    }) => { servers: unknown[]; dms: Array<{ channelId: string }> }
    expect(trim({
      servers: [],
      dms: [{ channelId: "dm_hidden" }, { channelId: "dm_other" }],
    }).dms).toEqual([{ channelId: "dm_other" }])
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: communityKeys.inbox() })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: communityKeys.dms() })

    fireDocumentVisibility("visible")
    await settle()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(setQueryData).toHaveBeenCalledTimes(1)
  })

  it("does not consume the eager intent before the snapshot is ready", async () => {
    const useHook = await loadHook()
    useHook({ dmId: "dm_waiting", snapshotReady: false })
    flushEffects()
    fireDocumentVisibility("visible")
    await settle()
    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(setQueryData).not.toHaveBeenCalled()
  })
})
