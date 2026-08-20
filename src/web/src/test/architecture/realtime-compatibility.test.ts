import { readdirSync, readFileSync } from "node:fs"
import { extname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const LEGACY_SPECIFIER = "@/lib/use-user-ws"

function sources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return sources(path)
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : []
  })
}

function importsLegacyAdapter(path: string): boolean {
  return readFileSync(path, "utf8").includes(LEGACY_SPECIFIER)
}

describe("legacy realtime adapter compatibility inventory", () => {
  it("locks the three production callers until their owning vertical slices", () => {
    const callers = sources(SRC_ROOT)
      .filter((path) => !path.includes(".test."))
      .filter((path) => !path.endsWith("test-harness.ts"))
      .filter(importsLegacyAdapter)
      .map((path) => relative(SRC_ROOT, path))
      .sort()

    expect(callers).toEqual([
      "app/(app)/studio/new/client.tsx",
      "contexts/agent-context.tsx",
      "hooks/community/use-community-ws.ts",
    ])
  })

  it("keeps the Community WS test harness attached to the compatibility path", () => {
    const harness = join(
      SRC_ROOT,
      "hooks/community/community-ws/test-harness.ts",
    )
    const source = readFileSync(harness, "utf8")

    expect(source).toContain(`from "${LEGACY_SPECIFIER}"`)
    expect(source).toContain(`vi.mock("${LEGACY_SPECIFIER}"`)
  })

  it("records the adapter deletion owners and prevents Community leakage into raw transport", () => {
    const adapter = readFileSync(join(SRC_ROOT, "lib/use-user-ws.ts"), "utf8")
    const transport = readFileSync(
      join(SRC_ROOT, "platform/client/realtime/realtime-transport.ts"),
      "utf8",
    )

    expect(adapter).toContain("Phases 2D, 7C, and 8C")
    expect(transport).not.toMatch(/COMMUNITY_BROWSER_EVENT_MAX_BYTES/)
    expect(transport).not.toMatch(/isCommunityEventCandidate|isCommunityEventType/)
    expect(transport).not.toMatch(/community_ws_frame_dropped/)
    expect(transport).not.toMatch(/check_daemon_status/)
  })
})
