import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { installBrowserProbe } from '../src/browser-probe.mjs'
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.setContent('<button id="send">Send</button><div id="rows"></div>')
  await page.evaluate(installBrowserProbe, { messageSelector: '[data-id]', submitSelector: '#send', idAttribute: 'data-id', optimisticPrefix: 'temp_' })
  await page.evaluate(() => window.__BENCHMARK_PROBE__.arm('unique'))
  await page.locator('#send').click()
  await page.evaluate(async () => {
    const rows = document.querySelector('#rows')
    rows.innerHTML = '<div data-id="temp_1">unique</div>'
    await Promise.resolve()
    rows.innerHTML = '<div data-id="canonical">unique</div>'
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const result = await page.evaluate(() => window.__BENCHMARK_PROBE__.freeze())
  assert.equal(result.messageId, 'canonical')
  assert.equal(result.isTrusted, true)
  assert.ok(result.nextFrameMs >= result.visibleMs)
  await page.evaluate(() => { document.querySelector('#rows').innerHTML = '<div data-id="later">unique</div>' })
  assert.equal(await page.evaluate(() => window.__BENCHMARK_PROBE__.snapshot()), null)
  await page.evaluate(() => {
    window.__BENCHMARK_PROBE__.arm('hidden')
    document.querySelector('#rows').innerHTML = '<div data-id="hidden" style="opacity:0">hidden</div><div data-id="offscreen" style="position:absolute;top:99999px">hidden</div>'
  })
  assert.equal((await page.evaluate(() => window.__BENCHMARK_PROBE__.snapshot())).visibleMs, null)
  console.log('Probe controls passed: trusted event, replacement before frame, freeze, hidden and offscreen rows')
} finally { await browser.close() }
