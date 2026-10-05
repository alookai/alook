import { readFileSync } from "node:fs"
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
    expect(frame).toContain("useSelectedLayoutSegments()")
    expect(frame).toContain("<ShellFrame")
    expect(readWeb("src/app/c/community-layout-client.tsx")).toContain("<CommunityRouteFrame")
    for (const path of ["src/app/c/channels/layout.tsx", "src/app/c/me/layout.tsx"]) {
      expect(readWeb(path)).not.toContain("<ShellFrame")
    }
    expect(readWeb("src/app/c/@sidebar/me/layout.tsx")).toContain("<DmSidebarSlot")
    expect(readWeb("src/app/c/@sidebar/channels/[serverId]/layout.tsx")).toContain("serverId={serverId}")
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
