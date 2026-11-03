import { test } from "./_fixtures/case-fixture"
import { runNeutralRootGeometry, seedGeometryRoutes } from "./_fixtures/community-loading-geometry"

test.describe("community light loading geometry", () => {
test("light: neutral root owns two viewport cold restores", async ({ caseActors }, testInfo) => {
    const actors = await caseActors(["dave", "bob"])
    const { asUser } = actors
    const serverIds: string[] = []
    await seedGeometryRoutes(serverIds, actors.seed, actors.userId)

    await runNeutralRootGeometry("light", asUser, testInfo, actors.userId, actors.onCleanup)
  })
})
