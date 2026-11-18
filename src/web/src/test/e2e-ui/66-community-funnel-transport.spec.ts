import { buildSync } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from '@alook/shared'
import { expect, test } from './_fixtures/case-fixture'

const webRoot = resolve(__dirname, '../../..')
const source = buildSync({
  entryPoints: [resolve(__dirname, '_fixtures/conversion-transport.ts')],
  bundle: true, platform: 'browser', format: 'iife', write: false,
  tsconfig: resolve(webRoot, 'tsconfig.json'),
  alias: { '@': resolve(webRoot, 'src') },
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
}).outputFiles[0].text
const eventDocument = readFileSync(resolve(webRoot, 'public/analytics-events.html'), 'utf8')

test('private connection and reply facts use the finite document without private page metadata', async ({ page }) => {
  let claims = 0
  let documents = 0
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== 'https://alook.ai') { await route.abort(); return }
    if (url.pathname === '/analytics-events.html') {
      documents++
      await route.fulfill({ contentType: 'text/html', body: eventDocument })
    } else if (url.pathname === '/api/community/analytics/funnel-events') {
      claims++
      await route.fulfill({ json: { events: [
        { event: 'runtime_connected', surface: 'community', connection_type: 'local_daemon' },
        { event: 'first_agent_reply_persisted', surface: 'community', conversation_type: 'thread' },
      ] }, headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })
    } else {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Controlled transport fixture</title><main>Conversion transport</main>' })
    }
  })
  await page.context().addCookies([{ name: '_ga', value: 'GA1.1.100.200', domain: 'alook.ai', path: '/' }])
  await page.goto('https://alook.ai/c/channels/private-server/private-channel?token=private-token')
  await page.addScriptTag({ content: source })
  await page.evaluate(async () => {
    const qa = Reflect.get(window, 'conversionQA')
    qa.bootstrapGoogleAnalytics()
    const owner = qa.createStore({ active: true, generation: 1 })
    Reflect.set(window, 'qaOwner', owner)
    await qa.drainCommunityFunnelEvents(owner)
  })
  const frame = page.frameLocator('#alook-product-events')
  await expect.poll(() => frame.locator('body').evaluate(() => Array.from((window.dataLayer ?? []) as ArrayLike<unknown>[], c => Array.from(c)).filter(c => c[0] === 'event').length)).toBe(2)
  const commands = await frame.locator('body').evaluate(() => Array.from((window.dataLayer ?? []) as ArrayLike<unknown>[], c => Array.from(c)).filter(c => c[0] === 'event'))
  expect(commands).toEqual([
    ['event', 'runtime_connected', { surface: 'community', connection_type: 'local_daemon', page_location: 'https://alook.ai/analytics/product', page_referrer: '', page_title: 'Alook', send_to: 'G-STBCL8F4ZY' }],
    ['event', 'first_agent_reply_persisted', { surface: 'community', conversation_type: 'thread', page_location: 'https://alook.ai/analytics/product', page_referrer: '', page_title: 'Alook', send_to: 'G-STBCL8F4ZY' }],
  ])
  expect(JSON.stringify(commands)).not.toContain('private-')
  expect(await page.evaluate(() => ({ disabled: Reflect.get(window, 'ga-disable-G-STBCL8F4ZY'), events: Array.from((window.dataLayer ?? []) as ArrayLike<unknown>[], c => Array.from(c)).filter(c => c[0] === 'event') }))).toEqual({ disabled: true, events: [] })
  expect((await page.context().cookies()).find(c => c.name === '_ga')?.value).toBe('GA1.1.100.200')
  expect(documents).toBe(1)
  expect(claims).toBe(1)
  await page.context().addCookies([{ name: 'alook_analytics_consent', value: 'v1.denied', domain: 'alook.ai', path: '/' }])
  await page.evaluate(async () => { await Reflect.get(window, 'conversionQA').drainCommunityFunnelEvents(Reflect.get(window, 'qaOwner')) })
  expect(claims).toBe(1)
})

for (const change of ['retire', 'deny'] as const) {
  test(`a delayed event document cannot send conversion facts after ${change}`, async ({ page }) => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let requested!: () => void
    const request = new Promise<void>(resolve => { requested = resolve })
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== 'https://alook.ai') { await route.abort(); return }
      if (url.pathname === '/analytics-events.html') {
        requested()
        await held
        await route.fulfill({ contentType: 'text/html', body: eventDocument })
      } else if (url.pathname === '/api/community/analytics/funnel-events') {
        await route.fulfill({ json: { events: [{ event: 'runtime_connected', surface: 'community', connection_type: 'local_daemon' }, { event: 'first_agent_reply_persisted', surface: 'community', conversation_type: 'dm' }] }, headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })
      } else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Controlled transport fixture</title>' })
    })
    try {
      await page.goto('https://alook.ai/c/me')
      await page.addScriptTag({ content: source })
      await page.evaluate(async () => {
        const qa = Reflect.get(window, 'conversionQA')
        const owner = qa.createStore({ active: true, generation: 1 })
        Reflect.set(window, 'qaOwner', owner)
        await qa.drainCommunityFunnelEvents(owner)
      })
      await request
      if (change === 'retire') await page.evaluate(() => Reflect.get(window, 'qaOwner').setState((s: { generation: number }) => ({ active: false, generation: s.generation + 1 })))
      else await page.context().addCookies([{ name: 'alook_analytics_consent', value: 'v1.denied', domain: 'alook.ai', path: '/' }])
      release()
      await expect.poll(() => page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('#alook-product-events')
        return !frame || frame.dataset.ready === 'true'
      })).toBe(true)
      expect(await page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('#alook-product-events')
        return frame ? Array.from((frame.contentWindow!.dataLayer ?? []) as ArrayLike<unknown>[], c => Array.from(c)).filter(c => c[0] === 'event') : []
      })).toEqual([])
    } finally { release() }
  })
}
