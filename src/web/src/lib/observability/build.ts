import { cleanAttributes } from "./schema"

export function resolveObservationBuild(env: Record<string, string | undefined>) {
  const release = [env.WORKERS_CI_COMMIT_SHA, env.CF_PAGES_COMMIT_SHA, env.GITHUB_SHA, env.NEXT_PUBLIC_FARO_RELEASE]
    .find(value => value && /^[0-9a-f]{40}$/.test(value))
  const environment = cleanAttributes({ environment: env.NEXT_PUBLIC_FARO_ENVIRONMENT }).environment
  return { release, environment, release_status: release ? "present" : "missing", environment_status: environment ? "present" : "missing" }
}
