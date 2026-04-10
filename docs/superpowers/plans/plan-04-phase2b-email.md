# Phase 2b — Email Worker

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans

**Goal:** Build the Email Worker that receives inbound emails, verifies agents via D1, stores in R2, and notifies the web service.

**Strategy:** Rewrite from migration docs. Use `@alook/shared` for Drizzle queries (read-only). Spec-plans code as structural reference.

**Depends on:** Phase 1 (shared library must be complete)

**Can run in parallel with:** Phase 2a, Phase 2c

---

### Task 1: Email handler implementation

**Files:**
- Modify: `src/email-worker/src/index.ts` (replace placeholder)

- [ ] Write the email worker following `docs/migration/02-email-worker.md` spec.

**Key differences from spec-plans' `temp/spec-plans/src/email-worker/src/index.ts`:**
1. Use `createDb` and `queries` from `@alook/shared` instead of local `getDb` with raw SQL
2. Read-only D1 access — no `createEmail`, no `createEvent`
3. Notify web service via `POST /api/email/notify` — web service handles all writes

```typescript
import { createDb, queries, parseEmailHandle } from "@alook/shared"
import { nanoid } from "nanoid"

interface EmailEnv {
  DB: D1Database
  EMAIL_BUCKET: R2Bucket
  WEB_SERVICE: Fetcher
}

export default {
  async fetch(request: Request, env: EmailEnv): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== "/simulate" || request.method !== "POST") {
      return new Response("POST /simulate to send a test email", { status: 404 })
    }

    const body = await request.json() as { from: string; to: string; subject?: string; body?: string }
    if (!body.from || !body.to) {
      return new Response("from and to required", { status: 400 })
    }

    const raw = [
      `From: ${body.from}`,
      `To: ${body.to}`,
      `Subject: ${body.subject ?? "(test)"}`,
      `Date: ${new Date().toUTCString()}`,
      "",
      body.body ?? "",
    ].join("\r\n")

    const rawStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw))
        controller.close()
      },
    })

    const headers = new Headers()
    headers.set("subject", body.subject ?? "(test)")

    const fakeMessage = {
      from: body.from,
      to: body.to,
      raw: rawStream,
      headers,
      setReject(reason: string) { console.log("Rejected:", reason) },
      forward(_to: string) { console.log("Forwarded to:", _to); return Promise.resolve() },
    } as unknown as ForwardableEmailMessage

    try {
      await this.email(fakeMessage, env)
      return Response.json({ ok: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return Response.json({ error: msg }, { status: 500 })
    }
  },

  async email(message: ForwardableEmailMessage, env: EmailEnv): Promise<void> {
    const db = createDb(env.DB)
    const handle = parseEmailHandle(message.to)

    // 1. Look up agent by handle
    const agent = await queries.agent.getAgentByHandle(db, handle)
    if (!agent) {
      message.setReject("No agent found for this address")
      return
    }

    // 2. Check whitelist
    const whitelisted = await queries.whitelist.isWhitelisted(
      db, agent.id, message.from
    )

    // 3. Store raw email in R2
    const rawBytes = await new Response(message.raw).arrayBuffer()
    const r2Key = `emails/${nanoid()}/raw`
    await env.EMAIL_BUCKET.put(r2Key, rawBytes, {
      httpMetadata: { contentType: "message/rfc822" },
    })

    const subject = message.headers.get("subject") ?? ""

    // 4. Notify web service (it handles all writes)
    if (whitelisted) {
      await env.WEB_SERVICE.fetch("http://internal/api/email/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          r2Key,
          from: message.from,
          subject,
          isWhitelisted: true,
        }),
      })
    } else {
      // Resolve forward address
      const forwardTo = (agent.forwardToEmail as string) ||
        (await queries.user.getUser(db, agent.ownerId as string))?.email || ""
      const forwarded = !!forwardTo

      await env.WEB_SERVICE.fetch("http://internal/api/email/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          r2Key,
          from: message.from,
          subject,
          isWhitelisted: false,
          forwarded,
        }),
      })

      if (forwardTo) {
        await message.forward(forwardTo)
      }
    }
  },
}
```

- [ ] Commit

```bash
git add src/email-worker/src/index.ts
git commit -m "feat(email-worker): inbound email handler with shared queries"
```

---

### Task 2: Test mocks

**Files:**
- Create: `src/email-worker/src/__mocks__/cf.ts`

- [ ] Create mocks for D1, R2, Fetcher, and ForwardableEmailMessage. Reference `temp/spec-plans/src/email-worker/src/__mocks__/cf.ts` for structure, but adapt for Drizzle:

Since the email worker now uses `createDb` from `@alook/shared` instead of raw D1, tests need to mock at the Drizzle query level. Use `vi.mock("@alook/shared")` to mock `createDb` and `queries`.

```typescript
import { vi } from "vitest"

export function createMockR2() {
  return { put: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket
}

export function createMockFetcher() {
  const fetcher = {
    fetch: vi.fn().mockResolvedValue(new Response("ok")),
  }
  return fetcher as unknown as Fetcher
}

export function createMockMessage(opts: {
  from: string
  to: string
  subject?: string
  body?: string
}) {
  const raw = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject ?? ""}`,
    "",
    opts.body ?? "",
  ].join("\r\n")

  const rawStream = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(raw)); c.close() },
  })

  const headers = new Headers()
  headers.set("subject", opts.subject ?? "")

  return {
    from: opts.from,
    to: opts.to,
    raw: rawStream,
    headers,
    setReject: vi.fn(),
    forward: vi.fn().mockResolvedValue(undefined),
  } as unknown as ForwardableEmailMessage
}
```

- [ ] Commit

```bash
git add src/email-worker/src/__mocks__/
git commit -m "feat(email-worker): test mocks"
```

---

### Task 3: Tests

**Files:**
- Create: `src/email-worker/src/index.test.ts`

- [ ] Write tests covering the flows from `docs/migration/02-email-worker.md`:

Test groups:
1. **Agent resolution:** reject when no agent found, parse handle correctly
2. **R2 storage:** correct key format, content-type set
3. **Whitelisted path:** stores R2, notifies web service with `isWhitelisted: true`
4. **Non-whitelisted path:** stores R2, notifies with `isWhitelisted: false`, forwards when forward_to_email set
5. **Error propagation:** D1 failure, R2 failure

Mock `@alook/shared`'s `createDb` and `queries` at the module level. Mock the env bindings (R2, Fetcher) using the helpers from Task 2.

- [ ] Run tests: `cd src/email-worker && pnpm test`
- [ ] Commit

```bash
git add src/email-worker/src/index.test.ts
git commit -m "feat(email-worker): tests for email handler"
```

**Exit criteria:** Email worker compiles, tests pass. Uses `@alook/shared` for D1 reads, notifies web service for writes.
