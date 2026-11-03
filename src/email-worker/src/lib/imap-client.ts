import { connect } from "cloudflare:sockets"

export interface ImapClientOptions {
  host: string
  port: number
  tls: boolean
  auth: { username: string; password: string }
  readTimeoutMs?: number
}

export class ImapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ImapError"
  }
}

export class ImapAuthError extends ImapError {
  readonly permanent: boolean
  constructor(message: string, permanent = false) {
    super(message)
    this.name = "ImapAuthError"
    this.permanent = permanent
  }
}

const DEFAULT_READ_TIMEOUT_MS = 15_000

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

export class ImapClient {
  private socket: Socket | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private encoder = new TextEncoder()
  private tagCounter = 0
  private readTimeoutMs: number
  private pending = new Uint8Array(0)

  constructor(private options: ImapClientOptions) {
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS
  }

  async connect(): Promise<void> {
    const opts: Record<string, unknown> = { allowHalfOpen: true }
    if (this.options.tls) opts.secureTransport = "starttls"

    this.socket = connect(
      { hostname: this.options.host, port: this.options.port },
      opts as any,
    )

    if (this.options.tls) {
      this.socket = this.socket.startTls()
    }

    this.writer = this.socket.writable.getWriter()
    this.reader = this.socket.readable.getReader()

    await this.readGreeting()

    const tag = this.nextTag()
    const user = this.quote(this.options.auth.username)
    const pass = this.quote(this.options.auth.password)

    try {
      await this.sendCommand(tag, `LOGIN ${user} ${pass}`)
    } catch (err) {
      if (err instanceof ImapError) {
        const upper = err.message.toUpperCase()
        const permanent = upper.includes("[AUTHENTICATIONFAILED]") || upper.includes("INVALID CREDENTIALS")
        throw new ImapAuthError(err.message, permanent)
      }
      throw err
    }
  }

  async select(folder: string): Promise<{ exists: number }> {
    const tag = this.nextTag()
    const resp = new TextDecoder().decode(await this.sendCommand(tag, `SELECT ${this.quote(folder)}`))
    const existsMatch = resp.match(/\* (\d+) EXISTS/)
    return { exists: existsMatch ? parseInt(existsMatch[1]!, 10) : 0 }
  }

  async command(tag: string, cmd: string): Promise<Uint8Array<ArrayBuffer>> {
    return this.sendCommand(tag, cmd)
  }

  async logout(): Promise<void> {
    try {
      const tag = this.nextTag()
      await this.writer?.write(this.encoder.encode(`${tag} LOGOUT\r\n`))
    } catch { /* best-effort */ }
    await this.close()
  }

  async close(): Promise<void> {
    try { this.reader?.releaseLock() } catch { /* ignore */ }
    try { this.writer?.releaseLock() } catch { /* ignore */ }
    try { await this.socket?.close() } catch { /* ignore */ }
    this.socket = null
    this.writer = null
    this.reader = null
    this.pending = new Uint8Array(0)
  }

  private nextTag(): string {
    return `A${++this.tagCounter}`
  }

  private async sendCommand(tag: string, cmd: string): Promise<Uint8Array<ArrayBuffer>> {
    if (!this.writer || !this.reader) throw new ImapError("Not connected")
    await this.writer.write(this.encoder.encode(`${tag} ${cmd}\r\n`))
    return this.readUntilTag(tag)
  }

  private async readGreeting(): Promise<void> {
    const decoder = new TextDecoder()
    while (true) {
      const line = decoder.decode(await this.readLine("Connection closed before greeting"))
      if (line.startsWith("* OK")) return
      if (line.startsWith("* BYE")) {
        throw new ImapError(`Server rejected connection: ${line.trim()}`)
      }
    }
  }

  private async readUntilTag(tag: string): Promise<Uint8Array<ArrayBuffer>> {
    if (!this.reader) throw new ImapError("Not connected")
    const decoder = new TextDecoder()
    const parts: Uint8Array[] = []
    while (true) {
      const bytes = await this.readLine(`IMAP stream ended without tagged response for ${tag}`)
      parts.push(bytes)
      const line = decoder.decode(bytes)
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1).split(/[\s]/, 1)[0]
        if (status === "OK") return concatBytes(parts)
        if (status === "NO" || status === "BAD") {
          throw new ImapError(`IMAP ${tag} failed: ${line.trim()}`)
        }
      }

      // Literal payload is opaque octets, including any CRLF or apparent tag lines.
      const literal = line.match(/\{(\d+)\}\r\n$/)
      if (literal) {
        const size = Number(literal[1])
        if (!Number.isSafeInteger(size)) throw new ImapError("Invalid IMAP literal size")
        parts.push(await this.readBytes(size))
      }
    }
  }

  private async readLine(ended: string): Promise<Uint8Array<ArrayBuffer>> {
    let scan = 0
    while (true) {
      for (; scan + 1 < this.pending.byteLength; scan++) {
        if (this.pending[scan] === 13 && this.pending[scan + 1] === 10) {
          const line = this.pending.subarray(0, scan + 2)
          this.pending = this.pending.subarray(scan + 2)
          return line
        }
      }
      const chunk = await this.timedRead()
      if (chunk.done) throw new ImapError(ended)
      this.pending = concatBytes([this.pending, chunk.value])
    }
  }

  private async readBytes(size: number): Promise<Uint8Array<ArrayBuffer>> {
    const parts: Uint8Array[] = []
    let remaining = size
    while (remaining > 0) {
      if (this.pending.byteLength === 0) {
        const chunk = await this.timedRead()
        if (chunk.done) throw new ImapError("IMAP stream ended inside literal")
        this.pending = concatBytes([chunk.value])
      }
      const count = Math.min(remaining, this.pending.byteLength)
      parts.push(this.pending.subarray(0, count))
      this.pending = this.pending.subarray(count)
      remaining -= count
    }
    return concatBytes(parts)
  }

  private async timedRead(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (!this.reader) throw new ImapError("Not connected")
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new ImapError("IMAP read timeout")), this.readTimeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }

  private quote(s: string): string {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  }
}
