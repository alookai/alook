import { cleanAttributes } from "./schema"

export function resolveObservationBuild(env: Record<string, string | undefined>) {
  const release = [env.WORKERS_CI_COMMIT_SHA, env.CF_PAGES_COMMIT_SHA, env.GITHUB_SHA]
    .find(value => value && /^[0-9a-f]{40}$/.test(value))
  return resolveObservationLabels({ release, environment: env.NODE_ENV })
}

export function resolveObservationLabels(labels: { release?: string; environment?: string }) {
  const { release, environment } = cleanAttributes(labels)
  return { release, environment, release_status: release ? "present" : "missing", environment_status: environment ? "present" : "missing" }
}
