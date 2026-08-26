import { describe, expect, it } from "vitest"
import {
  encodeMemberSearchCursor,
  parseMemberSearchCursor,
} from "./member-search-cursor"

describe("member search cursor", () => {
  const cursor = {
    serverId: "srv_1",
    query: "阿 li|ce",
    name: "Alice | 阿",
    id: "member_2",
  }

  it("round-trips names and queries that cannot use a delimiter cursor", () => {
    const encoded = encodeMemberSearchCursor(cursor)
    expect(encoded).not.toContain(cursor.name)
    expect(parseMemberSearchCursor(encoded, {
      serverId: cursor.serverId,
      query: cursor.query,
    })).toEqual({ name: cursor.name, id: cursor.id })
  })

  it("rejects malformed and cross-scope cursors", () => {
    const encoded = encodeMemberSearchCursor(cursor)
    expect(parseMemberSearchCursor("invalid", {
      serverId: cursor.serverId,
      query: cursor.query,
    })).toBeNull()
    expect(parseMemberSearchCursor(encoded, {
      serverId: "srv_2",
      query: cursor.query,
    })).toBeNull()
    expect(parseMemberSearchCursor(encoded, {
      serverId: cursor.serverId,
      query: "Bob",
    })).toBeNull()
  })

  it("treats an absent cursor as the first page", () => {
    expect(parseMemberSearchCursor(null, {
      serverId: cursor.serverId,
      query: cursor.query,
    })).toBeUndefined()
  })
})
