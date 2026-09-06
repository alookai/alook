import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { cleanupAuthenticatedNativeOauthResidue } from "./native-oauth-authenticated-cleanup"

const snapshot = {
  attemptId: "a".repeat(43),
  provider: "google",
  redirectPath: "/c/me/machines",
  expiresAt: Date.now() + 60_000,
  waiting: true,
} as const

const proof = {
  attemptId: snapshot.attemptId,
  state: "s".repeat(43),
  verifier: "v".repeat(43),
}

function makeDeps() {
  return {
    isDesktopTauri: vi.fn(() => true),
    invoke: vi.fn(async (command: string) => {
      if (command === "native_oauth_snapshot") return snapshot
      if (command === "native_oauth_cancel") return proof
      throw new Error(`unexpected command: ${command}`)
    }),
    postCancel: vi.fn(async () => new Response(null, { status: 204 })),
  }
}

describe("cleanupAuthenticatedNativeOauthResidue", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("is a no-op outside desktop Tauri", async () => {
    const deps = makeDeps()
    deps.isDesktopTauri.mockReturnValue(false)

    await cleanupAuthenticatedNativeOauthResidue(deps)

    expect(deps.invoke).not.toHaveBeenCalled()
    expect(deps.postCancel).not.toHaveBeenCalled()
  })

  it("only reads the snapshot when no attempt exists", async () => {
    const deps = makeDeps()
    deps.invoke.mockResolvedValue(null)

    await cleanupAuthenticatedNativeOauthResidue(deps)

    expect(deps.invoke).toHaveBeenCalledExactlyOnceWith("native_oauth_snapshot")
    expect(deps.postCancel).not.toHaveBeenCalled()
  })

  it("cancels the exact residue locally before posting the proof", async () => {
    const deps = makeDeps()

    await cleanupAuthenticatedNativeOauthResidue(deps)

    expect(deps.invoke.mock.calls).toEqual([
      ["native_oauth_snapshot"],
      ["native_oauth_cancel", { attemptId: snapshot.attemptId }],
    ])
    expect(deps.postCancel).toHaveBeenCalledExactlyOnceWith(proof)
  })

  it.each(["snapshot", "cancel"])(
    "does not contact the server when native %s fails",
    async (failure) => {
      const deps = makeDeps()
      deps.invoke.mockImplementation(async (command: string) => {
        if (command === "native_oauth_snapshot") {
          if (failure === "snapshot") throw new Error("store unavailable")
          return snapshot
        }
        if (command === "native_oauth_cancel") throw new Error("store unavailable")
        throw new Error(`unexpected command: ${command}`)
      })

      await expect(cleanupAuthenticatedNativeOauthResidue(deps)).rejects.toThrow(
        "store unavailable",
      )
      expect(deps.postCancel).not.toHaveBeenCalled()
    },
  )

  it("retries native cleanup on a later authenticated mount", async () => {
    const deps = makeDeps()
    deps.invoke.mockRejectedValueOnce(new Error("store unavailable"))

    await expect(cleanupAuthenticatedNativeOauthResidue(deps)).rejects.toThrow(
      "store unavailable",
    )
    expect(deps.postCancel).not.toHaveBeenCalled()

    await cleanupAuthenticatedNativeOauthResidue(deps)

    expect(deps.invoke.mock.calls.slice(-2)).toEqual([
      ["native_oauth_snapshot"],
      ["native_oauth_cancel", { attemptId: snapshot.attemptId }],
    ])
    expect(deps.postCancel).toHaveBeenCalledExactlyOnceWith(proof)
  })

  it("keeps completed local cleanup final when server cancellation returns 503", async () => {
    const deps = makeDeps()
    deps.postCancel.mockResolvedValue(new Response(null, { status: 503 }))

    await expect(cleanupAuthenticatedNativeOauthResidue(deps)).resolves.toBeUndefined()
    expect(deps.invoke.mock.calls).toEqual([
      ["native_oauth_snapshot"],
      ["native_oauth_cancel", { attemptId: snapshot.attemptId }],
    ])
  })

  it("mounts only behind both authenticated layout gates", () => {
    const appLayout = readFileSync(new URL("../app/(app)/layout.tsx", import.meta.url), "utf8")
    const communityLayout = readFileSync(new URL("../app/c/layout.tsx", import.meta.url), "utf8")

    expect(appLayout.indexOf("if (!session) redirect")).toBeLessThan(
      appLayout.indexOf("<AuthenticatedNativeOauthCleanup />"),
    )
    expect(communityLayout.indexOf("if (isPending || !session)")).toBeLessThan(
      communityLayout.indexOf("<AuthenticatedNativeOauthCleanup />"),
    )
  })
})
