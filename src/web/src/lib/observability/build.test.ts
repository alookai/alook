import { expect, it } from "vitest"
import { resolveObservationBuild, resolveObservationLabels } from "./build"

it("uses native CI source priority and NODE_ENV despite old manual overrides", () => {
  expect(resolveObservationBuild({ WORKERS_CI_COMMIT_SHA: "a".repeat(40), CF_PAGES_COMMIT_SHA: "b".repeat(40), GITHUB_SHA: "c".repeat(40), NODE_ENV: "production", NEXT_PUBLIC_FARO_RELEASE: "d".repeat(40), NEXT_PUBLIC_FARO_ENVIRONMENT: "qa" }))
    .toEqual({ release: "a".repeat(40), environment: "production", release_status: "present", environment_status: "present" })
  expect(resolveObservationBuild({ WORKERS_CI_COMMIT_SHA: "abbreviated", CF_PAGES_COMMIT_SHA: "b".repeat(40), GITHUB_SHA: "c".repeat(40), NODE_ENV: "development" }))
    .toEqual({ release: "b".repeat(40), environment: "development", release_status: "present", environment_status: "present" })
  expect(resolveObservationBuild({ WORKERS_CI_COMMIT_SHA: "", CF_PAGES_COMMIT_SHA: "invalid", GITHUB_SHA: "c".repeat(40) }).release).toBe("c".repeat(40))
})

it("does not use manual Faro aliases or package versions as source provenance", () => {
  expect(resolveObservationBuild({ NEXT_PUBLIC_FARO_RELEASE: "a".repeat(40), NEXT_PUBLIC_FARO_ENVIRONMENT: "production", NEXT_PUBLIC_APP_VERSION: "0.1.56" }))
    .toEqual({ release: undefined, environment: undefined, release_status: "missing", environment_status: "missing" })
  expect(resolveObservationBuild({ WORKERS_CI_COMMIT_SHA: "0.1.56", NODE_ENV: "production" }))
    .toEqual({ release: undefined, environment: "production", release_status: "missing", environment_status: "present" })
})

it("keeps absent or unsupported environment labels explicitly missing", () => {
  for (const NODE_ENV of [undefined, "", "test", "private"]) {
    expect(resolveObservationBuild({ NODE_ENV }).environment_status).toBe("missing")
  }
})

it("validates already compiled labels without resolving source inputs again", () => {
  expect(resolveObservationLabels({ release: "a".repeat(40), environment: "qa" }))
    .toEqual({ release: "a".repeat(40), environment: "qa", release_status: "present", environment_status: "present" })
  expect(resolveObservationLabels({ release: "abbreviated", environment: "private" }))
    .toEqual({ release: undefined, environment: undefined, release_status: "missing", environment_status: "missing" })
})
