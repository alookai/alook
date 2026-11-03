import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("SettingsMembers loading geometry", () => {
  it("keeps search, count, and the loaded scroll owner", () => {
    const source = readFileSync(new URL("./server-settings.tsx", import.meta.url), "utf8")
    expect(source).toContain(
      "<SettingsMembersSkeleton showSearch={Boolean(onSearch)} />",
    )
    expect(source).toContain(
      // The settings column width now comes from SettingsShellPanel (QA #20).
      'className="flex h-full min-h-0 w-full flex-col"',
    )
    expect(source).toContain('className="mb-4 h-11 shrink-0 rounded-md sm:h-9"')
    expect(source).toContain(
      'className="min-h-0 flex-1 overflow-y-auto thin-scrollbar"',
    )
  })
})
