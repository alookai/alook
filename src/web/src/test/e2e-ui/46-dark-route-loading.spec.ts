import { test } from "./_fixtures/case-fixture"
import { runRouteLoadingGeometry, seedGeometryRoutes } from "./_fixtures/community-loading-geometry"

test.describe("community dark loading geometry", () => {
test("dark: 18 route × viewport pending→loaded pairs keep shell CLS at zero", async ({ caseActors }, testInfo) => {
    test.setTimeout(600_000)
    const actors = await caseActors(["dave", "bob"])
    const { asUser } = actors
    const serverIds: string[] = []
    const routes = await seedGeometryRoutes(serverIds, actors.seed, actors.userId)

    await runRouteLoadingGeometry("dark", routes, asUser, testInfo, actors.onCleanup)
  })
})
