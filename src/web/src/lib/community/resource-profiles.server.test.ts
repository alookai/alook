import { afterEach, expect, it, vi } from "vitest"
import { queries, type Database } from "@alook/shared"
import { profileResourceFixture } from "@/test/community-resource-fixtures"
import { createCommunityResourceProfileReader } from "./resource-profiles.server"

afterEach(() => vi.restoreAllMocks())

it("shares overlapping in-flight IDs within one authorized request and keeps other requests separate", async () => {
  const load = vi.spyOn(queries.communityUserProfile, "getResourceProfiles").mockImplementation(async (_db, ids) => ids.map(id => profileResourceFixture({ id })))
  const db = {} as Database
  const read = createCommunityResourceProfileReader(db)
  const first = read(["peer"]), second = read(["peer", "author", "peer"])
  expect(await first).toMatchObject([{ id: "peer" }])
  expect(await second).toMatchObject([{ id: "peer" }, { id: "author" }])
  await read(["peer", "author"])
  expect(load.mock.calls.map(([, ids]) => ids)).toEqual([["peer"], ["author"]])
  await createCommunityResourceProfileReader(db)(["peer"])
  expect(load).toHaveBeenCalledTimes(3)
})

it("releases rejected reads for the existing retry and never returns an unrequested profile", async () => {
  const error = new Error("D1 unavailable")
  const load = vi.spyOn(queries.communityUserProfile, "getResourceProfiles")
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce([profileResourceFixture({ id: "peer" }), profileResourceFixture({ id: "unrequested" })])
  const read = createCommunityResourceProfileReader({} as Database)
  await expect(read(["peer"])).rejects.toBe(error)
  expect(await read(["peer", "missing"])).toMatchObject([{ id: "peer" }])
  expect(await read(["missing"])).toEqual([])
  expect(await read([])).toEqual([])
  expect(load.mock.calls.map(([, ids]) => ids)).toEqual([["peer"], ["peer", "missing"]])
})
