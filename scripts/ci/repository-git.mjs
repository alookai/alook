const REPOSITORY_ROUTING_GIT_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
]

export function isolatedRepositoryGitEnvironment(source = process.env) {
  const env = { ...source }
  for (const name of REPOSITORY_ROUTING_GIT_ENV) delete env[name]
  return env
}
