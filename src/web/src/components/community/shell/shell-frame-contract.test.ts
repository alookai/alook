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

  it("keeps both layout importers on the one public ShellFrame API", () => {
    const channels = readWeb("src/app/c/channels/layout.tsx")
    const dm = readWeb("src/app/c/me/layout.tsx")

    for (const source of [channels, dm]) {
      expect(source).toContain(
        'import { ShellFrame } from "@/components/community/shell/shell-frame"',
      )
      expect(source).toContain("<ShellFrame")
      expect(source).toContain("mobileZone={mobileZone}")
      expect(source).toContain("setMobileZone={setMobileZone}")
      expect(source).toContain("sidebar={sidebar}")
      expect(source).toContain("goHome={goHome}")
      expect(source).toContain("goServer={goServer}")
    }
    expect(channels).toContain('view="server"')
    expect(channels).toContain("activeServerId={serverId}")
    expect(dm).toContain('view="dm"')
    expect(dm).toContain("activeServerId={undefined}")
  })

  it("keeps shell-frame as orchestration with one public component", () => {
    const source = readWeb("src/components/community/shell/shell-frame.tsx")
    expect(source.match(/export function /g)).toHaveLength(1)
    expect(source).toContain("export function ShellFrame")
    expect(source).toContain("useShellRailController")
    expect(source).toContain("useShellProfileController")
    expect(source).toContain("useShellInboxController")
    expect(source).toContain("<ShellFrameView")
    expect(source).not.toContain("<ServerRail")
    expect(source).not.toContain("<ProfileCard")
    expect(source).not.toContain("<InboxPopover")
  })
})
