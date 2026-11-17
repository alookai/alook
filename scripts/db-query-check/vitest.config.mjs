import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { instrumentSource } from './source-context.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../src/shared/vitest.config.ts'
import web from '../../src/web/vitest.config.ts'
import auth from '../../src/web/auth/vitest.config.ts'
import ws from '../../src/ws-do/vitest.config.ts'
import email from '../../src/email-worker/vitest.config.ts'
import queue from '../../src/queue-worker/vitest.config.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const setup = fileURLToPath(new URL('./setup.mjs', import.meta.url))
const projects = [['shared', shared, 'src/shared'], ['web', web, 'src/web'], ['auth', auth, 'src/web/auth'], ['ws', ws, 'src/ws-do'], ['email', email, 'src/email-worker'], ['queue', queue, 'src/queue-worker']]
const inventory = JSON.parse(readFileSync(process.env.ALOOK_DB_QUERY_INVENTORY, 'utf8'))
const sites = [...inventory.sites, ...(inventory.fixtureSites ?? [])]
const plugin = { name: 'db-query-source', enforce: 'pre', transform(code, id) {
  const file = relative(root, id.split('?')[0]).replaceAll('\\', '/')
  const matches = sites.filter(site => site.file === file)
  return matches.length ? { code: instrumentSource(code, matches), map: null } : undefined
} }
export default defineConfig({
  test: {
    projects: [...projects.map(([name, config, directory]) => mergeConfig(config, { root: resolve(root, directory), plugins: [plugin], test: { name: `db-${name}`, setupFiles: [setup] } })), { root, plugins: [plugin], test: { name: 'db-tool-integration', environment: 'node', include: ['scripts/db-query-check/native-queries.test.ts'], setupFiles: [setup] } }],
    maxWorkers: 1,
    fileParallelism: false,
  },
})
