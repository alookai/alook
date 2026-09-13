import { test } from "./_fixtures/community-fixture"
import {
  runAndroidLoadingGeometry,
  runSkeletonLoadingMotion,
} from "./_fixtures/community-loading-geometry"

test.describe.serial("community Android loading geometry", () => {
  test("Android Chrome/WebView keep parsed SSR layouts mobile before application JS and through hydration", async ({ asUser }, testInfo) => {
    test.setTimeout(240_000)
    await runAndroidLoadingGeometry(asUser, testInfo)
  })

  test("community skeleton pulse changes only opacity and stops for reduced motion", async ({ asUser }) => {
    await runSkeletonLoadingMotion(asUser)
  })
})
