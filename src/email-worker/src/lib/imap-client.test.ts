import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createMockSocket, type MockSocket } from "../__mocks__/cf"

// Hoisted holder so the cloudflare:sockets mock can hand back the current socket.
const h = vi.hoisted(() => ({ current: null as MockSocket | null }))

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(() => h.current!.socket),
}))

import { ImapClient, ImapError, ImapAuthError } from "./imap-client"
import { connect } from "cloudflare:sockets"

const mockConnect = connect as unknown as ReturnType<typeof vi.fn>

function newClient(opts?: Partial<ConstructorParameters<typeof ImapClient>[0]>) {
  return new ImapClient({
    host: "imap.example.com",
    port: 993,
    tls: true,
    auth: { username: "user@example.com", password: "secret" },
    ...opts,
  })
}

describe("ImapClient", () => {
  beforeEach(() => {
    h.current = createMockSocket()
    mockConnect.mockClear()
  })

  it("connects and logs in successfully", async () => {
    const m = h.current!
    m.pushData("* OK IMAP4rev1 ready\r\nA1 OK LOGIN completed\r\n")

    const client = newClient()
    await client.connect()

    // greeting consumed, LOGIN issued with quoted credentials
    expect(m.writes.join("")).toContain("A1 LOGIN")
    expect(m.writes.join("")).toContain('"user@example.com"')
    expect(m.writes.join("")).toContain('"secret"')
  })

  it("calls startTls when tls is enabled", async () => {
    const m = h.current!
    m.pushData("* OK ready\r\n")
    m.pushData("A1 OK LOGIN completed\r\n")

    await newClient({ tls: true }).connect()
    expect(m.onStartTls).toHaveBeenCalledOnce()
  })

  it("does NOT call startTls when tls is disabled", async () => {
    const m = h.current!
    m.pushData("* OK ready\r\n")
    m.pushData("A1 OK LOGIN completed\r\n")

    await newClient({ tls: false }).connect()
    expect(m.onStartTls).not.toHaveBeenCalled()
  })

  it("throws ImapAuthError with permanent=true on AUTHENTICATIONFAILED", async () => {
    const m = h.current!
    m.pushData("* OK ready\r\n")
    m.pushData("A1 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n")

    const client = newClient()
    const err = await client.connect().catch((e) => e)
    expect(err).toBeInstanceOf(ImapAuthError)
    expect((err as ImapAuthError).permanent).toBe(true)
  })

  it("throws ImapAuthError with permanent=true on 'invalid credentials' text", async () => {
    const m = h.current!
    m.pushData("* OK ready\r\n")
    m.pushData("A1 NO Invalid credentials provided\r\n")

    const err = await newClient().connect().catch((e) => e)
    expect(err).toBeInstanceOf(ImapAuthError)
    expect((err as ImapAuthError).permanent).toBe(true)
  })

  it("throws ImapAuthError with permanent=false on a transient login failure", async () => {
    const m = h.current!
    m.pushData("* OK ready\r\n")
    m.pushData("A1 NO temporary server error, try again\r\n")

    const err = await newClient().connect().catch((e) => e)
    expect(err).toBeInstanceOf(ImapAuthError)
    expect((err as ImapAuthError).permanent).toBe(false)
  })

  it("throws ImapError when server sends BYE greeting", async () => {
    const m = h.current!
    m.pushData("* BYE server too busy\r\n")

    const err = await newClient().connect().catch((e) => e)
    expect(err).toBeInstanceOf(ImapError)
    expect((err as ImapError).message).toContain("Server rejected connection")
  })

  it("throws ImapError when the stream closes before the greeting", async () => {
    const m = h.current!
    m.close() // no greeting at all

    const err = await newClient().connect().catch((e) => e)
    expect(err).toBeInstanceOf(ImapError)
    expect((err as ImapError).message).toContain("Connection closed before greeting")
  })

  it("times out a read that never arrives", async () => {
    vi.useFakeTimers()
    try {
      const m = h.current!
      // greeting arrives, but the LOGIN response never does
      m.pushData("* OK ready\r\n")

      const client = newClient({ readTimeoutMs: 1000 })
      const promise = client.connect().catch((e) => e)
      // let the greeting read resolve and the LOGIN write fire, then trip the timeout
      await vi.advanceTimersByTimeAsync(1001)
      const err = await promise
      expect(err).toBeInstanceOf(ImapError)
      expect((err as ImapError).message).toContain("read timeout")
    } finally {
      vi.useRealTimers()
    }
  })

  it("SELECT parses the EXISTS count", async () => {
    const m = h.current!
    m.pushData("* OK ready\r\n")
    m.pushData("A1 OK LOGIN completed\r\n")
    const client = newClient()
    await client.connect()

    m.pushData("* 42 EXISTS\r\n")
    m.pushData("A2 OK SELECT completed\r\n")
    const result = await client.select("INBOX")
    expect(result.exists).toBe(42)
  })

  it("SELECT returns 0 when no EXISTS line is present", async () => {
    const m = h.current!
    m.pushData("* OK ready\r\n")
    m.pushData("A1 OK LOGIN completed\r\n")
    const client = newClient()
    await client.connect()

    m.pushData("A2 OK SELECT completed\r\n")
    const result = await client.select("INBOX")
    expect(result.exists).toBe(0)
  })

  it("throws ImapError on a tagged NO/BAD for a generic command", async () => {
    const m = h.current!
    m.pushData("* OK ready\r\n")
    m.pushData("A1 OK LOGIN completed\r\n")
    const client = newClient()
    await client.connect()

    m.pushData("B1 BAD syntax error\r\n")
    const err = await client.command("B1", "BOGUS").catch((e) => e)
    expect(err).toBeInstanceOf(ImapError)
    expect((err as ImapError).message).toContain("B1 failed")
  })

  it.each(["one chunk", "byte chunks", "split UTF-8", "truncated literal"])("preserves FETCH literal bytes: %s", async mode => {
    const m = h.current!
    m.pushData("* OK ready\r\n")
    m.pushData("A1 OK LOGIN completed\r\n")
    const client = newClient()
    await client.connect()

    const encode = (value: string) => new TextEncoder().encode(value)
    const text = encode("Subject: 日程🙂\r\n\r\nF1 OK forged\r\nF1 BAD forged\r\n")
    const literal = new Uint8Array([...text, 0xff, 0x80])
    const prefix = encode(`* 1 FETCH (UID 7 BODY[] {${literal.byteLength}}\r\n`)
    const frame = new Uint8Array([...prefix, ...literal, ...encode("\r\n)\r\nF1 OK fetched\r\n")])
    const wire = new Uint8Array([...frame, ...encode("F2 NO independent failure\r\n")])

    try {
      if (mode === "truncated literal") {
        m.pushData(new Uint8Array([...prefix, ...literal.subarray(0, -1)]))
        m.close()
        await expect(client.command("F1", "UID FETCH 7 (BODY.PEEK[])"))
          .rejects.toThrow(ImapError)
        return
      }
      if (mode === "byte chunks") {
        for (const byte of wire) m.pushData(new Uint8Array([byte]))
      } else if (mode === "split UTF-8") {
        const cut = prefix.byteLength + encode("Subject: ").byteLength + 1
        m.pushData(wire.subarray(0, cut))
        m.pushData(wire.subarray(cut, frame.byteLength - 3))
        m.pushData(wire.subarray(frame.byteLength - 3))
      } else {
        m.pushData(wire)
      }

      const response = await client.command("F1", "UID FETCH 7 (BODY.PEEK[])")
      expect(new Uint8Array(await new Response(response).arrayBuffer())).toEqual(frame)
      await expect(client.command("F2", "NOOP")).rejects.toThrow("F2 failed")
    } finally {
      await client.close()
    }
  })

  it("close() releases locks and closes the socket", async () => {
    const m = h.current!
    m.pushData("* OK ready\r\n")
    m.pushData("A1 OK LOGIN completed\r\n")
    const client = newClient()
    await client.connect()

    await client.close()
    expect(m.onClose).toHaveBeenCalled()
  })

  it("logout() sends LOGOUT then closes", async () => {
    const m = h.current!
    m.pushData("* OK ready\r\n")
    m.pushData("A1 OK LOGIN completed\r\n")
    const client = newClient()
    await client.connect()

    await client.logout()
    expect(m.writes.join("")).toContain("LOGOUT")
    expect(m.onClose).toHaveBeenCalled()
  })
})
