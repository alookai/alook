import { describe, it, expect, vi, beforeEach } from "vitest"

const listServersNeedingIconBackfill = vi.fn()
const setServerIcon = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityServer: {
        listServersNeedingIconBackfill: (...a: unknown[]) =>
          listServersNeedingIconBackfill(...a),
        setServerIcon: (...a: unknown[]) => setServerIcon(...a),
      },
    },
  }
})

import {
  backfillCommunityServerIcons,
  type R2Like,
} from "./backfill-community-server-icons"

// Mock R2 binding: canned list responses per prefix, and a delete recorder.
function makeR2(objects: Record<string, Array<{ key: string; uploaded?: Date }>>) {
  const deleteCalls: string[] = []
  const media: R2Like & { deleteCalls: string[] } = {
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      objects: objects[prefix] ?? [],
    })),
    delete: vi.fn(async (key: string) => {
      deleteCalls.push(key)
    }),
    deleteCalls,
  }
  return media
}

const db = {} as never

describe("backfillCommunityServerIcons", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setServerIcon.mockResolvedValue(undefined)
  })

  it("converts URL-shaped rows to R2 keys, sweeps older objects, leaves NULL/orphan rows alone when empty", async () => {
    listServersNeedingIconBackfill.mockResolvedValue([
      { id: "s-a", icon: "/api/community/servers/s-a/icon" },
      { id: "s-b", icon: "/api/community/servers/s-b/icon" },
      { id: "s-c", icon: "/api/community/servers/s-c/icon" },
      { id: "s-d", icon: null }, // untouched — no objects on disk, already null
    ])

    const media = makeR2({
      "server-icon/s-a/": [
        { key: "server-icon/s-a/old", uploaded: new Date("2026-01-01") },
        { key: "server-icon/s-a/new", uploaded: new Date("2026-06-01") },
      ],
      "server-icon/s-b/": [
        { key: "server-icon/s-b/only", uploaded: new Date("2026-05-01") },
      ],
      "server-icon/s-c/": [
        { key: "server-icon/s-c/a", uploaded: new Date("2026-02-01") },
        { key: "server-icon/s-c/b", uploaded: new Date("2026-03-01") },
        { key: "server-icon/s-c/c", uploaded: new Date("2026-04-01") },
      ],
      "server-icon/s-d/": [],
    })

    const report = await backfillCommunityServerIcons(db, media, { log: () => {} })

    expect(report.scanned).toBe(4)
    expect(report.updated).toBe(3) // s-a, s-b, s-c pinned to newest
    expect(report.cleared).toBe(0) // s-d already null
    expect(report.skipped).toBe(1)
    expect(report.deletedObjects).toBe(3) // (2-1) + (1-1) + (3-1)

    const iconUpdates = setServerIcon.mock.calls
      .filter((c) => c[2] !== null)
      .map((c) => ({ id: c[1], icon: c[2] }))
      .sort((a, b) => a.id.localeCompare(b.id))
    expect(iconUpdates).toEqual([
      { id: "s-a", icon: "server-icon/s-a/new" },
      { id: "s-b", icon: "server-icon/s-b/only" },
      { id: "s-c", icon: "server-icon/s-c/c" },
    ])

    expect(media.deleteCalls.sort()).toEqual([
      "server-icon/s-a/old",
      "server-icon/s-c/a",
      "server-icon/s-c/b",
    ])
  })

  it("dry-run reports the same shape without writing to DB or R2", async () => {
    listServersNeedingIconBackfill.mockResolvedValue([
      { id: "s-x", icon: "/api/community/servers/s-x/icon" },
    ])
    const media = makeR2({
      "server-icon/s-x/": [
        { key: "server-icon/s-x/old", uploaded: new Date("2026-01-01") },
        { key: "server-icon/s-x/new", uploaded: new Date("2026-05-01") },
      ],
    })

    const report = await backfillCommunityServerIcons(db, media, {
      dryRun: true,
      log: () => {},
    })

    expect(report.updated).toBe(1)
    expect(report.deletedObjects).toBe(1)
    expect(setServerIcon).not.toHaveBeenCalled()
    expect(media.deleteCalls).toHaveLength(0)
  })

  it("clears URL-shaped rows to NULL when no historical R2 objects exist", async () => {
    listServersNeedingIconBackfill.mockResolvedValue([
      { id: "s-orphan", icon: "/api/community/servers/s-orphan/icon" },
    ])
    const media = makeR2({
      "server-icon/s-orphan/": [],
    })

    const report = await backfillCommunityServerIcons(db, media, { log: () => {} })

    expect(report.cleared).toBe(1)
    expect(setServerIcon).toHaveBeenCalledWith(db, "s-orphan", null)
  })
})
