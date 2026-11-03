import { test } from "./_fixtures/case-fixture"
import { runDesktopPersistedPendingGeometry, seedGeometryRoutes } from "./_fixtures/community-loading-geometry"

test.describe("community light loading geometry", () => {
test("light: persisted desktop sidebars keep every pending-frame boundary aligned", async ({ caseActors }) => {
    test.setTimeout(360_000)
    const actors = await caseActors(["dave", "bob", "geometry"])
    const { asUser } = actors
    const serverIds: string[] = []
    await seedGeometryRoutes(serverIds, actors.seed, actors.userId)

    await runDesktopPersistedPendingGeometry("light", asUser, actors.onCleanup)
  })
})
