import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("InviteAcceptClient loading geometry", () => {
  it("reserves the ready landing title, metadata, CTA, members, and footer stack", () => {
    const source = readFileSync(new URL("./invite-accept-client.tsx", import.meta.url), "utf8")
    expect(source).toContain('className="mt-1 h-10 w-56 rounded"')
    expect(source).toContain('className="mt-4 flex h-5 items-center gap-1.5"')
    expect(source).toContain('className="mt-6 h-11 w-full rounded-xl"')
    expect(source).toContain('className="mt-4 flex h-5 items-center gap-2"')
    expect(source).toContain('className="mt-3 h-3 w-32 rounded"')
  })
})
