import contractText0 from "../../../app/c/community-authenticated-entry.tsx?raw"
import contractText1 from "./community-route-frame.tsx?raw"
import contractText2 from "./shell-frame-view.tsx?raw"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const shellDirectory = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(shellDirectory, "../../../..")
const contractSources: Record<string, string> = {
  "src/app/c/community-authenticated-entry.tsx": contractText0,
  "src/components/community/shell/community-route-frame.tsx": contractText1,
  "src/components/community/shell/shell-frame-view.tsx": contractText2,
}
const readWeb = (path: string) => {
  if (!(path in contractSources)) throw new Error("unregistered contract source: " + path)
  return contractSources[path]
}

describe("ShellFrame public contract", () => {
  it("keeps the one frame above both native slots and content layouts", () => {
    const frame = readWeb("src/components/community/shell/community-route-frame.tsx")
    expect(frame).toContain("<ShellFrame")
    expect(readWeb("src/app/c/community-authenticated-entry.tsx")).toContain("<CommunityRouteFrame")
    for (const path of ["src/app/c/channels/layout.tsx", "src/app/c/me/layout.tsx"]) {
      expect(existsSync(resolve(webRoot, path))).toBe(false)
    }
    const shellView = readWeb("src/components/community/shell/shell-frame-view.tsx")
    expect(shellView.match(/<DmSidebarSlot\b/g)).toHaveLength(1)
    expect(existsSync(resolve(webRoot, "src/app/c/@sidebar"))).toBe(false)
    expect(shellView.match(/<ServerSidebarSlot\b/g)).toHaveLength(1)
  })

})
