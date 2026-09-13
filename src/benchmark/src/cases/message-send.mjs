import { setTimeout as sleep } from 'node:timers/promises'
import { prepareFixture, messageEvents } from '../client.mjs'
import { installBrowserProbe } from '../browser-probe.mjs'

export const defaultScenario = {
  path: '/c/channels/{serverId}/{channelId}',
  composerSelector: '[data-testid="community-composer-input"] [contenteditable="true"]',
  submitAction: 'enter', scrollToPresentSelector: '[data-testid="community-scroll-to-present"]',
  submitSelector: '[data-testid="community-composer-send"]',
  messageSelector: '[data-msg-id]', idAttribute: 'data-msg-id', optimisticPrefix: 'temp_',
  sendPath: '/api/community/channels/{channelId}/messages',
}
const fillPath = (template, fixture) => template.replace(/\{(serverId|channelId)\}/g, (_, key) => encodeURIComponent(fixture[key]))

export function messageSendCase(config) {
  const scenario = { ...defaultScenario, ...config.scenario }
  return {
    id: 'channel-message-send', version: 1, options: scenario,
    metrics: {
      senderVisibleMs: { label: 'Sender DOM visible', unit: 'ms', successOnly: true },
      receiverVisibleMs: { label: 'Receiver DOM visible', unit: 'ms', successOnly: true },
      senderNextFrameMs: { label: 'Sender next frame', unit: 'ms', successOnly: true },
      receiverNextFrameMs: { label: 'Receiver next frame', unit: 'ms', successOnly: true },
      senderReconciledMs: { label: 'Sender reconciled (diagnostic)', unit: 'ms', successOnly: true },
      duplicateMessageFrames: { label: 'Duplicate receiver message frames', unit: 'count', successOnly: false },
    },
    async prepare() {
      if (config.receivers !== 1 || !Array.isArray(config.fixture.accounts) || config.fixture.accounts.length < 2) throw new Error('Message case requires two distinct users and receivers=1')
      if (scenario.submitAction && !['enter', 'click'].includes(scenario.submitAction)) throw new Error('Invalid submitAction')
      if (!Array.isArray(config.payloadBytes) || config.payloadBytes.some(size => size < 64)) throw new Error('Message case requires at least 64 content bytes')
      const fixture = await prepareFixture(config)
      return { fixture, participants: config.fixture.accounts.slice(0, 2).map((account, role) => ({ name: role === 0 ? 'sender' : 'receiver', cookie: account.cookie, path: fillPath(scenario.path, fixture) })),
        workloads: config.payloadBytes.map(payloadBytes => ({ id: `content-${payloadBytes}`, label: `${payloadBytes} content B`, params: { payloadBytes } })) }
    },
    classifyRequest({ request, role, fixture }) {
      const url = new URL(request.url())
      const direct = url.origin === config.baseUrl && role === 0 && request.method() === 'POST' && url.pathname === fillPath(scenario.sendPath, fixture)
      let clientNonce = null
      if (direct) { try { const body = request.postDataJSON(); clientNonce = body?.nonce ?? body?.clientNonce ?? null } catch {} }
      return { direct, inject: direct, observeDB: url.pathname.startsWith('/api/'), details: direct ? { clientNonce } : null }
    },
    responseDetails({ record, body }) { return record.direct ? { messageId: JSON.parse(body.toString('utf8'))?.message?.id ?? null } : null },
    frameDetails({ payload }) {
      let parsed
      try { parsed = JSON.parse(payload.toString()) } catch {}
      return { ready: parsed?.type === 'auth.ok' ? true : undefined, details: { type: parsed?.type ?? 'unparsed', messages: parsed ? messageEvents(parsed).map(event => ({ id: event.message.id, clientNonce: event.message.clientNonce ?? null })) : [] } }
    },
    async setupPage({ page, connection }) {
      await page.locator(scenario.composerSelector).waitFor({ state: 'visible', timeout: config.timeoutMs })
      const deadline = performance.now() + config.timeoutMs
      while (!connection.ready && performance.now() < deadline) await sleep(25)
      if (!connection.ready) throw new Error('Real page WS did not authenticate')
      await sleep(500)
      const scroll = page.locator(scenario.scrollToPresentSelector)
      while (await scroll.isVisible()) {
        if (performance.now() >= deadline) throw new Error('Could not prepare latest messages')
        await scroll.click(); await sleep(350)
      }
      if (await page.locator(scenario.composerSelector).count() !== 1) throw new Error('Expected one composer')
      await page.evaluate(installBrowserProbe, scenario)
    },
    async prepareSample({ pages, workload, id }) {
      const marker = `benchmark-${id.slice(0, 8)}-${id.split('-').at(-1)}-`
      const text = marker + 'x'.repeat(workload.params.payloadBytes - marker.length)
      await pages[0].page.locator(scenario.composerSelector).fill(text)
      return { text }
    },
    async arm({ pages, input }) { await Promise.all(pages.map(item => item.page.evaluate(text => window.__BENCHMARK_PROBE__.arm(text), input.text))) },
    async perform({ pages }) {
      if (pages.some(item => !item.connection.ready)) throw new Error('Page WS disconnected')
      if (scenario.submitAction === 'enter') await pages[0].page.locator(scenario.composerSelector).press('Enter', { timeout: config.timeoutMs })
      else await pages[0].page.locator(scenario.submitSelector).click({ timeout: config.timeoutMs })
      await Promise.all(pages.map(item => item.page.waitForFunction(() => {
        const sample = window.__BENCHMARK_PROBE__.snapshot()
        return sample && sample.visibleMs !== null && sample.nextFrameMs !== null && sample.messageId !== null
      }, undefined, { timeout: config.timeoutMs })))
    },
    freeze: ({ pages }) => Promise.all(pages.map(item => item.page.evaluate(() => window.__BENCHMARK_PROBE__.freeze()))),
    finish({ snapshot, operation, pages }) {
      const submit = { role: 0, atMs: snapshot[0]?.clickMs ?? null, eventType: snapshot[0]?.eventType, isTrusted: snapshot[0]?.isTrusted }
      const delta = value => Number.isFinite(value) && Number.isFinite(submit.atMs) ? value - submit.atMs : null
      const dom = snapshot.map((value, role) => ({ ...value, role, visibleMs: delta(value.visibleMs), nextFrameMs: delta(value.nextFrameMs), canonicalMs: delta(value.canonicalMs) }))
      const messageId = dom[0].messageId
      const sameCanonicalMessage = !!messageId && messageId === dom[1].messageId
      const sends = operation.requestsAtCutoff.filter(record => record.direct)
      const responseIds = sends.map(record => record.responseDetails?.messageId).filter(Boolean)
      const httpCanonicalMatch = responseIds.length > 0 ? responseIds.every(id => id === messageId) : null
      const receivedMessageFrames = operation.framesAtCutoff.filter(frame => frame.role === 1 && frame.details?.messages?.some(message => message.id === messageId)).length
      return { submit, metrics: { senderVisibleMs: dom[0].visibleMs, receiverVisibleMs: dom[1].visibleMs, senderNextFrameMs: dom[0].nextFrameMs, receiverNextFrameMs: dom[1].nextFrameMs, senderReconciledMs: dom[0].canonicalMs, duplicateMessageFrames: Math.max(0, receivedMessageFrames - 1) },
        diagnostics: { dom, clientNonce: sends[0]?.details?.clientNonce ?? null, sameCanonicalMessage, httpCanonicalMatch, receivedMessageFrames, wsDisconnected: pages.map(item => !item.connection.ready) },
        error: !sameCanonicalMessage ? 'canonical-message-mismatch' : httpCanonicalMatch === false ? 'http-message-mismatch' : null }
    },
  }
}
