import { test } from "./_fixtures/community-fixture"
import {
  runAndroidLoadingGeometry,
  runSkeletonLoadingMotion,
} from "./_fixtures/community-loading-geometry"

test.describe.serial("community Android loading geometry", () => {
  test("Android Chrome/WebView keep 320/390/639 cold frames mobile before breakpoint hydration", async ({ asUser }) => {
    test.setTimeout(240_000)
    await runAndroidLoadingGeometry(asUser)
  })

  test("community skeleton pulse changes only opacity and stops for reduced motion", async ({ asUser }) => {
    await runSkeletonLoadingMotion(asUser)
  })
})
