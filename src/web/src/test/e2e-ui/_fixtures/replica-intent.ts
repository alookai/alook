import { expect, type Page } from "@playwright/test"

const REPLICA_INTENTS_PATH = "/api/community/replica/intents"

export function waitForAcceptedReplicaTextIntent(
  page: Page,
  channelId: string,
  content: string,
  expectedPayload: { replyToId?: string; mentionType?: "everyone" } = {},
): Promise<{ channelId: string; messageId: string; seq: number }> {
  return page.waitForResponse((response) => {
    if (
      response.request().method() !== "POST"
      || new URL(response.url()).pathname !== REPLICA_INTENTS_PATH
    ) return false
    const body = response.request().postDataJSON() as {
      intents?: Array<{ payload?: { content?: string } }>
    }
    return body.intents?.some((intent) => intent.payload?.content === content) ?? false
  }).then(async (response) => {
    expect(response.status()).toBe(200)
    const request = response.request().postDataJSON() as {
      protocolVersion: number
      intents: Array<{
        intentId: string
        kind: string
        scope: { kind: string; id: string }
        payload: { content: string; replyToId?: string; mentionType?: "everyone" }
      }>
    }
    expect(request.protocolVersion).toBe(1)
    expect(request.intents).toHaveLength(1)
    expect(request.intents[0]).toMatchObject({
      kind: "message.send",
      scope: { kind: "channel", id: channelId },
      payload: { content, ...expectedPayload },
    })
    const requestScope = request.intents[0]!.scope

    const payload = await response.json() as {
      protocolVersion: number
      outcomes: Array<{
        intentId: string
        status: string
        canonical?: {
          scope: { kind: string; id: string }
          messageId: string
          seq: number
        }
      }>
    }
    expect(payload.protocolVersion).toBe(request.protocolVersion)
    expect(payload.outcomes).toHaveLength(1)
    expect(payload.outcomes[0]).toMatchObject({
      intentId: request.intents[0]!.intentId,
      status: "accepted",
      canonical: {
        scope: requestScope,
        messageId: expect.any(String),
        seq: expect.any(Number),
      },
    })
    const canonical = payload.outcomes[0]!.canonical!
    expect(canonical.seq).toBeGreaterThan(0)
    return {
      channelId: canonical.scope.id,
      messageId: canonical.messageId,
      seq: canonical.seq,
    }
  })
}
