import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyWorkspaceDependencies } from './workspace.mjs'

test('workspace source checks reject foreign or missing internal links and allow external package stores', t => {
  const directory = mkdtempSync(join(tmpdir(), 'query-workspace-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'candidate')
  const foreign = join(directory, 'other-checkout')
  for (const path of ['src/shared', 'src/web/node_modules/@fixture']) mkdirSync(join(root, path), { recursive: true })
  mkdirSync(foreign)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "src/shared"\n  - "src/web"\n')
  writeFileSync(join(root, 'src/shared/package.json'), JSON.stringify({ name: '@fixture/shared' }))
  writeFileSync(join(root, 'src/web/package.json'), JSON.stringify({ name: '@fixture/web', dependencies: { '@fixture/shared': 'workspace:*', 'external-library': '1' } }))
  writeFileSync(join(foreign, 'package.json'), JSON.stringify({ name: '@fixture/shared' }))
  const link = join(root, 'src/web/node_modules/@fixture/shared')
  symlinkSync(foreign, link, 'junction')
  assert.throws(() => verifyWorkspaceDependencies(root), /Mixed or incomplete workspace dependencies/)
  rmSync(link)
  symlinkSync(join(root, 'src/shared'), link, 'junction')
  symlinkSync(foreign, join(root, 'src/web/node_modules/external-library'), 'junction')
  assert.deepEqual(verifyWorkspaceDependencies(root), [{ consumer: 'src/web', dependency: '@fixture/shared', target: 'src/shared' }])
  rmSync(link)
  assert.throws(() => verifyWorkspaceDependencies(root), /missing workspace dependency @fixture\/shared/)
})
