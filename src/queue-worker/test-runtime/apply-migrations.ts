/// <reference types="@cloudflare/vitest-plugin/types" />

import type { D1Migration } from "@cloudflare/vitest-plugin"
import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { beforeAll } from "vitest"

const runtimeEnv = env as unknown as {
  DB: D1Database
  TEST_MIGRATIONS: D1Migration[]
}

beforeAll(async () => {
  await applyD1Migrations(runtimeEnv.DB, runtimeEnv.TEST_MIGRATIONS)
})
