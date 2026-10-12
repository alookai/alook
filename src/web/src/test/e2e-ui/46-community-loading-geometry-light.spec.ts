import { test } from "./_fixtures/case-fixture"
import {
  runDesktopPersistedPendingGeometry,
  runNeutralRootGeometry,
  runRouteLoadingGeometry,
  seedGeometryRoutes,
} from "./_fixtures/community-loading-geometry"

test.describe("community light loading geometry", () => {
  test("light: neutral root owns two viewport cold restores", async ({ caseActors }, testInfo) => {
    const actors = await caseActors(["dave", "bob"])
    const { asUser } = actors
    const serverIds: string[] = []
    await seedGeometryRoutes(serverIds, actors.seed, actors.userId)

    await runNeutralRootGeometry("light", asUser, testInfo, actors.userId, actors.onCleanup)
  })

  test("light: persisted desktop sidebars keep every pending-frame boundary aligned", async ({ caseActors }) => {
    test.setTimeout(360_000)
    const actors = await caseActors(["dave", "bob", "geometry"])
    const { asUser } = actors
    const serverIds: string[] = []
    await seedGeometryRoutes(serverIds, actors.seed, actors.userId)

    await runDesktopPersistedPendingGeometry("light", asUser, actors.onCleanup)
  })

  test("light: 18 route × viewport pending→loaded pairs keep shell CLS at zero", async ({ caseActors }, testInfo) => {
    test.setTimeout(600_000)
    const actors = await caseActors(["dave", "bob"])
    const { asUser } = actors
    const serverIds: string[] = []
    const routes = await seedGeometryRoutes(serverIds, actors.seed, actors.userId)

    await runRouteLoadingGeometry("light", routes, asUser, testInfo, actors.onCleanup)
  })
})
