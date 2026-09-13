import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, publicConfig } from '../src/config.mjs'

test('config rejects ambiguous targets/identities and public output excludes fixture secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'benchmark-config-'))
  const path = join(dir, 'config.json')
  const base = { baseUrl: 'http://localhost:3000', targetKind: 'local', targetVersion: 'sha', environment: 'test', fixtureFile: 'fixture.json' }
  const accounts = [{ cookie: 'secret-1', userId: 'one' }, { cookie: 'secret-2', userId: 'two' }]
  try {
    await writeFile(join(dir, 'fixture.json'), JSON.stringify({ accounts }))
    await writeFile(path, JSON.stringify(base))
    const config = await loadConfig(path)
    assert.equal(config.expectedMembers, 100)
    assert.equal(config.intervalMs, 400)
    assert.ok(!JSON.stringify(publicConfig(config)).includes('secret'))
    for (const override of [{ baseUrl: 'https://user:password@example.com' }, { wsUrl: 'ws://localhost/api/ws?token=secret' }, { receivers: 2 }, { samples: 0 }, { targetKind: 'production' }]) {
      await writeFile(path, JSON.stringify({ ...base, ...override }))
      await assert.rejects(loadConfig(path))
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
