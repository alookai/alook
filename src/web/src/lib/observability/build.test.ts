import { expect, it } from "vitest"
import { resolveObservationBuild } from "./build"

it("uses a full CI source SHA and marks absent or invalid provenance explicitly", () => {
  expect(resolveObservationBuild({ WORKERS_CI_COMMIT_SHA: "a".repeat(40), NEXT_PUBLIC_FARO_RELEASE: "b".repeat(40), NEXT_PUBLIC_FARO_ENVIRONMENT: "qa" }))
    .toEqual({ release: "a".repeat(40), environment: "qa", release_status: "present", environment_status: "present" })
  expect(resolveObservationBuild({ WORKERS_CI_COMMIT_SHA: "abbreviated", GITHUB_SHA: "b".repeat(40), NEXT_PUBLIC_FARO_ENVIRONMENT: "development" }).release).toBe("b".repeat(40))
  expect(resolveObservationBuild({ NEXT_PUBLIC_FARO_RELEASE: "0.1.46", NEXT_PUBLIC_FARO_ENVIRONMENT: "private" }))
    .toEqual({ release: undefined, environment: undefined, release_status: "missing", environment_status: "missing" })
})
