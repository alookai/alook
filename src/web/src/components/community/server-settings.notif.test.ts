/**
 * Regression for the server notification-level mis-store bug (plan task A8).
 *
 * Three spellings once coexisted for "every message": the option value
 * ("All messages", lowercase m), the mutation's normalize map ("All Messages"),
 * and the display map ("All Messages"). The lowercase value fell through
 * `normalizeNotifLevel` to `"mentions"`, so picking "Every message" stored
 * `mentions` (bug 1) AND the radio never highlighted because the display level
 * ("All Messages") never equalled the option value ("All messages") (bug 2).
 *
 * This test drives the real code paths on both sides of that comparison so the
 * two spellings can never drift apart again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient } from "@tanstack/react-query"
import { SERVER_NOTIF_LEVELS, SettingsNotifications } from "./server-settings"
import { displayNotifLevel } from "@/hooks/community/use-notification-settings"

// ── mutation-hook shim (mirrors mutations/channels.test.ts) ────────────────
const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type MutConfig<Args> = { mutationFn?: (args: Args) => unknown }
let capturedConfig: MutConfig<unknown> | null = null
let capturedQc: QueryClient
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedQc,
    useMutation: (config: MutConfig<unknown>) => {
      capturedConfig = config
      return {}
    },
  }
})

async function loadNotifMutations() {
  vi.resetModules()
  return await import("@/hooks/community/mutations/notifications")
}

beforeEach(() => {
  apiFetchMock.mockReset()
  capturedConfig = null
  capturedQc = new QueryClient()
})

// The single option the "Every message" button emits — read from the real
// options array so a spelling change here is caught, not hard-coded.
const everyMessage = SERVER_NOTIF_LEVELS.find((l) => l.label === "Every message")!

describe("server notification level — mis-store bug (A8)", () => {
  it("picking Every message PUTs level:'all', not 'mentions' (bug 1)", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadNotifMutations()
    mod.useSetServerNotifLevel()
    // Emulate the SettingsNotifications button → onSetNotifLevel → mutate path.
    await capturedConfig!.mutationFn!({ serverId: "srv_1", level: everyMessage.value })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = apiFetchMock.mock.calls[0] as [string, { body: string }]
    expect(url).toBe("/api/community/notifications")
    // Unified endpoint (M6) body shape; the A8 invariant is level:"all" (not "mentions").
    expect(JSON.parse(init.body)).toEqual({ scope: "server", id: "srv_1", level: "all" })
  })

  it("the stored 'all' level highlights the Every message option (bug 2 / R16)", () => {
    // `level` prop is what the settings UI feeds in: the display string derived
    // from the stored DB value via displayNotifLevel("all").
    const html = renderToStaticMarkup(
      createElement(SettingsNotifications, { level: displayNotifLevel("all") }),
    )
    // The selected option renders the filled inner dot. Both comparison sides
    // must resolve to the same spelling for it to appear.
    expect(html).toContain('class="size-2 rounded-full bg-primary"')
    // Sanity: the two sides literally agree.
    expect(displayNotifLevel("all")).toBe(everyMessage.value)
  })
})
