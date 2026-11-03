import contractText0 from "../avatar/bot-avatar-picker-dialog.tsx?raw"
import contractText1 from "./settings/user-settings.tsx?raw"
import contractText2 from "./shell/shell-frame-overlays.tsx?raw"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const componentDirectory = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(componentDirectory, "../../..")
const contractSources: Record<string, string> = {
  "src/components/avatar/bot-avatar-picker-dialog.tsx": contractText0,
  "src/components/community/settings/user-settings.tsx": contractText1,
  "src/components/community/shell/shell-frame-overlays.tsx": contractText2,
}
const readWeb = (path: string) => {
  if (!(path in contractSources)) throw new Error("unregistered contract source: " + path)
  return contractSources[path]
}

describe("community avatar shape contract", () => {
  it("keeps My Profile preview and crop circular", () => {
    const profile = readWeb("src/components/community/settings/user-settings.tsx")
    const shell = readWeb("src/components/community/shell/shell-frame-overlays.tsx")

    expect(profile).toContain(
      'className="block size-24 overflow-hidden rounded-full ring-1 ring-border/50"',
    )
    expect(shell).toMatch(/pendingAvatarCrop[\s\S]*maskShape="circle"/)
  })

  it("keeps every bot picker preview and crop circular", () => {
    const picker = readWeb("src/components/avatar/bot-avatar-picker-dialog.tsx")

    expect(picker).not.toContain("rounded-2xl")
    expect(picker.match(/rounded-full/g)).toHaveLength(5)
    expect(picker).toContain('maskShape="circle"')
    expect(picker).toContain("data-testid={tid.botAvatarPickerTrigger}")
    expect(picker).toContain('aria-label="Choose bot avatar"')
  })

})
