import { describe, expect, it, vi } from "vitest"
import { serverPropsEqual } from "./sortable-server"

const base = {
  server: {
    id: "server",
    name: "Server",
    initial: "S",
    active: false,
    unread: false,
    mentions: 2,
    icon: null,
  },
  onClick: vi.fn(),
}

describe("SortableServer unread memo boundary", () => {
  it("rerenders when official status changes", () => {
    const official = { ...base, server: { ...base.server, official: true } }
    expect(serverPropsEqual(base, official)).toBe(false)
    expect(serverPropsEqual(official, base)).toBe(false)
    expect(serverPropsEqual(official, { ...official, onClick: vi.fn() })).toBe(true)
  })

  it("rerenders for owned unread changes while ignoring callback identity", () => {
    expect(serverPropsEqual(base, { ...base, onClick: vi.fn() })).toBe(true)
    expect(serverPropsEqual(base, {
      ...base,
      server: { ...base.server, unread: true },
    })).toBe(false)
  })

  it("keeps mention and unread as independent presentation fields", () => {
    expect(serverPropsEqual(base, {
      ...base,
      server: { ...base.server, mentions: 3 },
    })).toBe(false)
    expect(base.server).toMatchObject({ unread: false, mentions: 2 })
  })
})
