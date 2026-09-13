import { setTimeout as sleep } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'

export async function api(baseUrl, account, path, { method = 'GET', body, timeoutMs = 15000, requestId } = {}) {
  const encoded = body === undefined ? undefined : JSON.stringify(body)
  const started = performance.now()
  const response = await fetch(new URL(path, baseUrl), {
    method, redirect: 'error', headers: { Cookie: account.cookie, Origin: new URL(baseUrl).origin,
      'Content-Type': 'application/json', ...(requestId ? { 'x-alook-benchmark-id': requestId } : {}) },
    body: encoded, signal: AbortSignal.timeout(timeoutMs),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  const wallMs = performance.now() - started
  let data = null
  let parseError = false
  try { data = JSON.parse(bytes.toString('utf8')) } catch { parseError = true }
  return { status: response.status, ok: response.ok, data, parseError, wallMs,
    requestBodyBytes: encoded === undefined ? 0 : Buffer.byteLength(encoded), responseBodyBytes: bytes.byteLength }
}

async function checked(baseUrl, account, path, options) {
  const result = await api(baseUrl, account, path, options)
  if (!result.ok || result.parseError) throw new Error(`Fixture API failed: ${options?.method ?? 'GET'} ${path} (${result.status})`)
  return result.data
}

export async function prepareFixture(config, create = false) {
  const { fixture, baseUrl } = config
  if (!Array.isArray(fixture.accounts) || fixture.accounts.some(a => typeof a.cookie !== 'string' || !a.cookie || typeof a.userId !== 'string' || !a.userId)) throw new Error('Fixture requires accounts with cookie and userId')
  if (new Set(fixture.accounts.map(a => a.userId)).size !== fixture.accounts.length) throw new Error('Fixture accounts must be distinct')
  for (const [key, min, max] of [['receivers', 1, 1000], ['expectedMembers', 2, 10000], ['historyLimit', 1, 100]]) if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}`)
  if (!Array.isArray(config.payloadBytes) || !config.payloadBytes.length || config.payloadBytes.some(n => !Number.isInteger(n) || n < 1 || n > 100000)) throw new Error('Invalid payloadBytes')
  if (fixture.accounts.length <= config.receivers) throw new Error('Fixture requires a sender plus configured receivers')
  const sender = fixture.accounts[0]
  if (create) {
    if (fixture.accounts.length !== config.expectedMembers) throw new Error('Creation requires exactly expectedMembers fixture accounts')
    const server = await checked(baseUrl, sender, '/api/community/servers', { method: 'POST', body: { name: `benchmark-${randomUUID().slice(0, 8)}` } })
    fixture.serverId = server.server.id
    const invite = await checked(baseUrl, sender, `/api/community/servers/${fixture.serverId}/invites`, { method: 'POST', body: {} })
    for (const account of fixture.accounts.slice(1)) {
      await checked(baseUrl, account, `/api/community/invites/${invite.invite.token}/join`, { method: 'POST' })
      await sleep(config.intervalMs)
    }
    const channel = await checked(baseUrl, sender, '/api/community/channels', { method: 'POST', body: { serverId: fixture.serverId, name: 'benchmark', type: 'text' } })
    fixture.channelId = channel.channel.id
  }
  if (!fixture.serverId || !fixture.channelId) throw new Error('Fixture needs serverId/channelId; run setup first')
  const channel = await checked(baseUrl, sender, `/api/community/channels/${fixture.channelId}`)
  if (channel.serverId !== fixture.serverId || channel.type !== 'text' || channel.parentChannelId || channel.categoryId) throw new Error('First version requires a top-level text channel in the configured server')
  const audience = await checked(baseUrl, sender, `/api/community/channels/${fixture.channelId}/members`)
  const visible = new Set(audience.members?.map(member => member.userId))
  const members = new Set()
  let cursor
  const seen = new Set()
  do {
    const path = `/api/community/servers/${fixture.serverId}/members?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const page = await checked(baseUrl, sender, path)
    if (!Array.isArray(page.members)) throw new Error('Invalid member page')
    for (const member of page.members) members.add(member.userId)
    cursor = page.hasMore ? page.cursor : undefined
    if (page.hasMore && (!cursor || seen.has(cursor))) throw new Error('Invalid member pagination')
    seen.add(cursor)
  } while (cursor)
  if (visible.size !== config.expectedMembers || [...visible].some(id => !members.has(id))) throw new Error('Channel audience does not match the expected server audience')
  if (members.size !== config.expectedMembers) throw new Error(`Observed ${members.size} server members; expected ${config.expectedMembers}`)
  for (const account of fixture.accounts.slice(0, config.receivers + 1)) {
    if (!members.has(account.userId)) throw new Error('A measured account is not a server member')
    await checked(baseUrl, account, `/api/community/channels/${fixture.channelId}/messages?limit=1`)
  }
  return { serverMembers: members.size, visibleMembers: visible.size, channelType: channel.type, measuredReceivers: config.receivers, channelId: fixture.channelId, serverId: fixture.serverId }
}

export function messageEvents(frame) {
  const events = frame.type === 'community:events.batch' ? frame.events : [frame]
  if (!Array.isArray(events)) return []
  return events.filter(event => event?.type === 'community:message.create' && typeof event.message?.id === 'string')
}

export async function connectReceiver(config, account, index, onMessage) {
  const auth = await checked(config.baseUrl, account, '/api/ws/token')
  if (auth.userId !== account.userId) throw new Error('WS fixture identity mismatch')
  const url = config.wsUrl ?? `${config.baseUrl.replace(/^http/, 'ws')}/api/ws/user`
  const endpoint = new URL(url)
  endpoint.searchParams.set('userId', auth.userId)
  const socket = new WebSocket(endpoint)
  let ready = false
  let closed = false
  let protocolErrors = 0
  const handshake = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('WS auth timeout')); socket.close() }, config.timeoutMs)
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', token: auth.token })))
    socket.addEventListener('message', event => {
      const at = performance.now()
      if (event.data === 'pong') return
      if (typeof event.data !== 'string') { protocolErrors++; return }
      let frame
      try { frame = JSON.parse(event.data) } catch { protocolErrors++; return }
      if (frame.type === 'auth.ok') { ready = true; clearTimeout(timeout); resolve(); return }
      if (!ready) return
      for (const message of messageEvents(frame)) onMessage({ receiver: index, messageId: message.message.id,
        channelId: message.channelId, clientNonce: message.message.clientNonce, at, frameBytes: Buffer.byteLength(event.data) })
    })
    socket.addEventListener('error', () => { if (!ready) { clearTimeout(timeout); reject(new Error('WS connection failed')) } })
    socket.addEventListener('close', () => { closed = true; clearTimeout(timeout); if (!ready) reject(new Error('WS closed before authentication')) })
  })
  try { await handshake } catch (error) { socket.close(); throw error }
  const heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('ping') }, 20000)
  return { state: () => ({ ready, closed, protocolErrors }), close: () => { clearInterval(heartbeat); socket.close() } }
}
