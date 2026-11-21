import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { prepareFixture } from '../src/client.mjs'

test('fixture rejects mismatched protocol, old channel shape, unreadable targets and non-JSON without leaking bodies', async () => {
  let header = '11'
  let channel = { contractVersion: 11, channelId: 'c', channel: { id: 'c', serverId: 's', type: 'text' }, access: { channelId: 'c', canRead: true, canSend: true, canCreateDiscussion: false } }
  let payload = channel
  const server = http.createServer((request, response) => {
    assert.equal(request.headers['x-alook-community-contract'], '11')
    response.setHeader('X-Alook-Community-Contract', header)
    response.setHeader('Content-Type', 'application/json')
    response.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const config = { communityContractVersion: 11, baseUrl: `http://127.0.0.1:${server.address().port}`, receivers: 1, expectedMembers: 2, historyLimit: 20, payloadBytes: [64], fixture: { serverId: 's', channelId: 'c', accounts: [{ userId: 'a', cookie: 'a' }, { userId: 'b', cookie: 'b' }] } }
  try {
    header = '10'
    await assert.rejects(prepareFixture(config), /Fixture API failed/)
    header = '11'
    for (payload of [{ ...channel, contractVersion: 10 }, channel.channel, { ...channel, access: { channelId: 'c' } }, { ...channel, access: { ...channel.access, canSend: false } }]) {
      await assert.rejects(prepareFixture(config), /Invalid current Community channel envelope/)
    }
    payload = '<html>private-upstream-response</html>'
    await assert.rejects(prepareFixture(config), error => !error.message.includes('private-upstream-response'))
  } finally { await new Promise(resolve => server.close(resolve)) }
})
