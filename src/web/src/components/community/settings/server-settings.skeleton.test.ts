import rawContractInput0 from "./server-settings.tsx?raw"
import { describe, expect, it } from "vitest"

describe("SettingsMembers loading geometry", () => {
  it("keeps search, count, and the loaded scroll owner", () => {
    const source = rawContractInput0
    expect(source).toContain(
      "<SettingsMembersSkeleton showSearch={Boolean(onSearch)} />",
    )
    expect(source).toContain(
      'className="mx-auto flex h-full min-h-0 max-w-xl flex-col"',
    )
    expect(source).toContain('className="mb-4 h-11 shrink-0 rounded-md sm:h-9"')
    expect(source).toContain(
      'className="min-h-0 flex-1 overflow-y-auto thin-scrollbar"',
    )
  })
})
