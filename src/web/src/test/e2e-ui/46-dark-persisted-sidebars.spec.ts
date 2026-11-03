import { test } from "./_fixtures/case-fixture"
import { runDesktopPersistedPendingGeometry, seedGeometryRoutes } from "./_fixtures/community-loading-geometry"

test.describe("community dark loading geometry", () => {
test("dark: persisted desktop sidebars keep every pending-frame boundary aligned", async ({ caseActors }) => {
    test.setTimeout(240_000)
    const actors = await caseActors(["dave", "bob", "geometry"])
    const { asUser } = actors
    const serverIds: string[] = []
    await seedGeometryRoutes(serverIds, actors.seed, actors.userId)

    await runDesktopPersistedPendingGeometry("dark", asUser, actors.onCleanup)
  })
})
