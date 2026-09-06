import { test } from "./_fixtures/community-fixture"
import {
  runNeutralRootGeometry,
  runRouteLoadingGeometry,
  seedGeometryRoutes,
} from "./_fixtures/community-loading-geometry"

test.describe.serial("community light loading geometry", () => {
  let routes!: Awaited<ReturnType<typeof seedGeometryRoutes>>

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    routes = await seedGeometryRoutes()
  })

  test("light: neutral root owns two viewport cold restores", async ({ asUser }, testInfo) => {
    await runNeutralRootGeometry("light", asUser, testInfo)
  })

  test("light: 18 route × viewport pending→loaded pairs keep shell CLS at zero", async ({ asUser }, testInfo) => {
    test.setTimeout(600_000)
    await runRouteLoadingGeometry("light", routes, asUser, testInfo)
  })
})
