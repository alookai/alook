import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

export async function loadConfig(path) {
  const source = JSON.parse(await readFile(path, 'utf8'))
  const config = {
    observeDB: false, observationWindowMs: 1800, samples: 100, warmup: 5, concurrency: 1, timeoutMs: 15000, intervalMs: 400,
    payloadBytes: [64, 1024], receivers: 1, expectedMembers: 100, historyLimit: 20,
    phases: [{ name: 'baseline', phase: 'request', delayMs: 0 }, { name: 'request-delay', phase: 'request', delayMs: 1000 }, { name: 'response-delay', phase: 'response', delayMs: 1000 }],
    ...source,
  }
  const url = new URL(config.baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('baseUrl must be a credential-free HTTP(S) origin')
  if (!['local', 'staging'].includes(config.targetKind)) throw new Error('targetKind must explicitly name local or staging')
  if (!config.targetVersion || !config.environment) throw new Error('Record targetVersion and environment')
  for (const [key, min, max] of [['samples', 1, 100000], ['warmup', 0, 10000], ['concurrency', 1, 100], ['timeoutMs', 100, 120000], ['intervalMs', 0, 60000], ['receivers', 1, 1000], ['expectedMembers', 2, 10000], ['historyLimit', 1, 100], ['observationWindowMs', 100, 120000]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}`)
  }
  if (!Array.isArray(config.payloadBytes) || !config.payloadBytes.length || config.payloadBytes.some(n => !Number.isInteger(n) || n < 1 || n > 100000)) throw new Error('Invalid payloadBytes')
  if (!Array.isArray(config.phases) || !config.phases.length || new Set(config.phases.map(p => p.name)).size !== config.phases.length || config.phases.some(p => !/^[a-z0-9_-]+$/.test(p.name) || !['request', 'response'].includes(p.phase) || !Number.isInteger(p.delayMs) || p.delayMs < 0 || p.delayMs > 60000 || p.delayMs >= config.timeoutMs)) throw new Error('Invalid phases')
  if (config.headless !== undefined && typeof config.headless !== 'boolean') throw new Error('headless must be boolean')
  if (config.viewport && (!Number.isInteger(config.viewport.width) || !Number.isInteger(config.viewport.height) || config.viewport.width < 320 || config.viewport.height < 320)) throw new Error('Invalid viewport')
  if (config.scenario?.submitAction && !['enter', 'click'].includes(config.scenario.submitAction)) throw new Error('Invalid submitAction')
  if (typeof config.observeDB !== 'boolean') throw new Error('observeDB must be boolean')
  if (config.wsUrl) {
    const ws = new URL(config.wsUrl)
    if (!['ws:', 'wss:'].includes(ws.protocol) || ws.username || ws.password || ws.hash || ws.search) throw new Error('wsUrl must be a credential-free WS endpoint without query parameters')
  }
  const fixture = JSON.parse(await readFile(resolve(dirname(path), config.fixtureFile), 'utf8'))
  if (!Array.isArray(fixture.accounts) || fixture.accounts.length <= config.receivers || fixture.accounts.some(a => typeof a.cookie !== 'string' || !a.cookie || typeof a.userId !== 'string' || !a.userId)) throw new Error('Fixture requires a sender plus receivers with cookie and userId')
  if (new Set(fixture.accounts.map(a => a.userId)).size !== fixture.accounts.length) throw new Error('Fixture accounts must be distinct')
  config.fixture = fixture
  config.baseUrl = url.origin
  config.outDir = resolve(dirname(path), config.outDir ?? 'artifacts/latest')
  return config
}

export function publicConfig(config) {
  return Object.fromEntries(['observeDB', 'baseUrl', 'targetKind', 'targetVersion', 'environment', 'samples', 'warmup', 'concurrency', 'timeoutMs', 'intervalMs', 'payloadBytes', 'receivers', 'expectedMembers', 'historyLimit', 'phases'].map(key => [key, config[key]]))
}
