import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { beforeAll } from "vitest"

beforeAll(async () => { await applyD1Migrations(env.REGISTRY, env.TEST_MIGRATIONS) })
