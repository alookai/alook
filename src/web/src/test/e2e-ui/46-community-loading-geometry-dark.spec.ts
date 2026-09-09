import { test } from "./_fixtures/community-fixture"
import {
  runDesktopPersistedPendingGeometry,
  runNeutralRootGeometry,
  runRouteLoadingGeometry,
  seedGeometryRoutes,
} from "./_fixtures/community-loading-geometry"

test.describe.serial("community dark loading geometry", () => {
  let routes!: Awaited<ReturnType<typeof seedGeometryRoutes>>

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    routes = await seedGeometryRoutes()
  })

  test("dark: neutral root owns two viewport cold restores", async ({ asUser }, testInfo) => {
    await runNeutralRootGeometry("dark", asUser, testInfo)
  })

  test("dark: persisted desktop sidebars keep every pending-frame boundary aligned", async ({ asUser }) => {
    test.setTimeout(240_000)
    await runDesktopPersistedPendingGeometry("dark", asUser)
  })

  test("dark: 18 route × viewport pending→loaded pairs keep shell CLS at zero", async ({ asUser }, testInfo) => {
    test.setTimeout(600_000)
    await runRouteLoadingGeometry("dark", routes, asUser, testInfo)
  })
})
