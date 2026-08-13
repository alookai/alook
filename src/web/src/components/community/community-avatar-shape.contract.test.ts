import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const componentDirectory = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(componentDirectory, "../../..")
const readWeb = (path: string) => readFileSync(resolve(webRoot, path), "utf8")

describe("community avatar shape contract", () => {
  it("keeps My Profile preview and crop circular", () => {
    const profile = readWeb("src/components/community/edit-profile-dialog.tsx")
    const shell = readWeb("src/components/community/shell-frame.tsx")

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

  it("leaves the workspace agent picker rounded-square", () => {
    const picker = readWeb("src/components/avatar/avatar-picker-dialog.tsx")

    expect(picker).toContain('className="block size-20 overflow-hidden rounded-2xl"')
    expect(picker).not.toContain("rounded-full")
    expect(picker).toContain('data-testid="workspace-agent-avatar-preview"')
  })
})
