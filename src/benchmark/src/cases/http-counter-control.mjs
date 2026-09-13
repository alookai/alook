export function httpCounterControl(config) {
  return {
    id: 'http-counter-control', version: 1,
    metrics: { counterVisibleMs: { label: 'Counter DOM update', unit: 'ms', successOnly: true } },
    async prepare() { return { fixture: { kind: 'synthetic-tool-control' }, participants: [{ name: 'counter', path: '/' }], workloads: [{ id: 'increment', label: 'Increment by one', params: {} }] } },
    async setupPage({ page }) {
      await page.locator('#increment').waitFor({ state: 'visible', timeout: config.timeoutMs })
      await page.evaluate(() => {
        let active = null
        document.addEventListener('click', event => {
          if (active && event.target.closest('#increment')) active.submit = { role: 0, atMs: performance.timeOrigin + performance.now(), isTrusted: event.isTrusted, eventType: event.type }
        }, true)
        new MutationObserver(() => {
          if (active?.submit && document.querySelector('#count').textContent !== active.before && active.visibleAt === null) active.visibleAt = performance.timeOrigin + performance.now()
        }).observe(document.querySelector('#count'), { childList: true, subtree: true, characterData: true })
        window.__COUNTER_CONTROL__ = {
          arm() { active = { before: document.querySelector('#count').textContent, submit: null, visibleAt: null } },
          snapshot() { return active }, freeze() { const value = active; active = null; return value },
        }
      })
    },
    async prepareSample() { return {} },
    arm: ({ pages }) => pages[0].page.evaluate(() => window.__COUNTER_CONTROL__.arm()),
    async perform({ pages }) {
      await pages[0].page.locator('#increment').click({ timeout: config.timeoutMs })
      await pages[0].page.waitForFunction(() => window.__COUNTER_CONTROL__.snapshot()?.visibleAt !== null, undefined, { timeout: config.timeoutMs })
    },
    freeze: ({ pages }) => pages[0].page.evaluate(() => window.__COUNTER_CONTROL__.freeze()),
    finish({ snapshot }) { return { submit: snapshot.submit, metrics: { counterVisibleMs: snapshot.submit && snapshot.visibleAt !== null ? snapshot.visibleAt - snapshot.submit.atMs : null }, diagnostics: snapshot, error: snapshot.visibleAt === null ? 'counter-not-updated' : null } },
    classifyRequest({ request }) { const direct = new URL(request.url()).pathname === '/increment' && request.method() === 'POST'; return { direct, inject: direct, observeDB: false } },
  }
}
