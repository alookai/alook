import { DurableObject } from "cloudflare:workers"

export class ImapPollerDO extends DurableObject {
  async fetch(): Promise<Response> {
    return Response.json({ error: "IMAP has been retired" }, { status: 410 })
  }

  async alarm(): Promise<void> {}
}
