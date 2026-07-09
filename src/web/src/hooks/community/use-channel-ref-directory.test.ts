import { describe, it, expect } from "vitest"
import { buildChannelRefDirectory } from "./use-channel-ref-directory"
import type { Server, Category } from "@/components/community/_types"
import type { ServerDetail } from "./use-servers"

function server(id: string, name: string): Server {
  return { id, name, initial: name[0], active: false, mentions: 0 }
}

function detail(id: string, name: string, categories: Category[]): ServerDetail {
  return { id, name, description: "", icon: null, ownerId: "u1", categories }
}

function category(id: string, channels: Array<{ id: string; name: string }>): Category {
  return {
    id,
    name: id,
    channels: channels.map((c) => ({ id: c.id, name: c.name, active: false, unread: false })),
  }
}

describe("buildChannelRefDirectory", () => {
  it("flattens each server's categories[].channels into one channels array per server", () => {
    const servers = [server("s1", "Studio")]
    const detailsById = {
      s1: detail("s1", "Studio", [
        category("cat1", [{ id: "c1", name: "general" }, { id: "c2", name: "random" }]),
        category("cat2", [{ id: "c3", name: "dev" }]),
      ]),
    }
    const directory = buildChannelRefDirectory(servers, detailsById)
    expect(directory).toEqual([
      {
        id: "s1",
        name: "Studio",
        channels: [
          { id: "c1", name: "general" },
          { id: "c2", name: "random" },
          { id: "c3", name: "dev" },
        ],
      },
    ])
  })

  it("a server with no fetched detail yet yields an empty channels array, not a crash", () => {
    const servers = [server("s1", "Studio"), server("s2", "Other")]
    const detailsById = { s1: detail("s1", "Studio", [category("cat1", [{ id: "c1", name: "general" }])]) }
    const directory = buildChannelRefDirectory(servers, detailsById)
    expect(directory).toEqual([
      { id: "s1", name: "Studio", channels: [{ id: "c1", name: "general" }] },
      { id: "s2", name: "Other", channels: [] },
    ])
  })

  it("returns [] for an empty server list", () => {
    expect(buildChannelRefDirectory([], {})).toEqual([])
  })
})
