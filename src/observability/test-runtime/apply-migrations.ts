/// <reference types="@cloudflare/vitest-plugin/types" />
import type { D1Migration } from "@cloudflare/vitest-plugin"
import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { beforeAll } from "vitest"

declare global {
  namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } }
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS) })
