import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ComponentProps } from "react"
import { describe, expect, expectTypeOf, it } from "vitest"
import { ShellFrame } from "./shell-frame"
import type { ShellFrameProps } from "./shell-frame-types"

const shellDirectory = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(shellDirectory, "../../../..")
const readWeb = (path: string) => readFileSync(resolve(webRoot, path), "utf8")

describe("ShellFrame public contract", () => {
  it("keeps the exact public prop shape", () => {
    expectTypeOf<ComponentProps<typeof ShellFrame>>().toEqualTypeOf<ShellFrameProps>()
  })

  it("keeps the one frame above both native slots and content layouts", () => {
    const frame = readWeb("src/components/community/shell/community-route-frame.tsx")
    expect(frame).toContain("usePathname()")
    expect(frame).toContain("<ShellFrame")
    expect(readWeb("src/app/c/community-layout-client.tsx")).toContain("<CommunityRouteFrame")
    for (const path of ["src/app/c/channels/layout.tsx", "src/app/c/me/layout.tsx"]) {
      expect(existsSync(resolve(webRoot, path))).toBe(false)
    }
    const shellView = readWeb("src/components/community/shell/shell-frame-view.tsx")
    expect(shellView.match(/<DmSidebarSlot\b/g)).toHaveLength(1)
    expect(existsSync(resolve(webRoot, "src/app/c/@sidebar"))).toBe(false)
    expect(shellView.match(/<ServerSidebarSlot\b/g)).toHaveLength(1)
    expect(frame).not.toContain("useSelectedLayoutSegments")
  })

  it("keeps shell-frame as orchestration with one public component", () => {
    const source = readWeb("src/components/community/shell/shell-frame.tsx")
    expect(source.match(/export function /g)).toHaveLength(1)
    expect(source).toContain("export function ShellFrame")
    expect(source).toContain("useShellRailController")
    expect(source).toContain("useShellProfileController")
    expect(source).toContain("useShellInboxController")
    expect(source).toContain("resolveCommunityCheckpointPlan")
    expect(source).toContain("useCommunityNavigationController")
    expect(source).toContain("<ShellFrameView")
    expect(source).not.toContain("<ServerRail")
    expect(source).not.toContain("<ProfileCard")
    expect(source).not.toContain("<InboxPopover")
  })
})
