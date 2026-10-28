import type { Command } from "commander"
import { readFile, stat } from "node:fs/promises"
import { z } from "zod"
import { CommunityBotCreateRequestSchema, MAX_SERVER_DESCRIPTION_LENGTH, MAX_SERVER_NAME_LENGTH, parseNameAndTag } from "@alook/shared"

const BotInput = z.strictObject({
  ...CommunityBotCreateRequestSchema.omit({ runtime: true, image: true }).shape,
  backendId: z.string().min(1).max(64),
})
const ServerInput = z.strictObject({ name: z.string().trim().min(1).max(MAX_SERVER_NAME_LENGTH), description: z.string().max(MAX_SERVER_DESCRIPTION_LENGTH).optional() })

async function readAccessCode(file: string | undefined): Promise<string> {
  let secret = process.env.ALOOK_ACCESS_CODE?.trim()
  if (file) {
    if ((await stat(file)).size > 1024) throw new Error("Access code file is too large")
    secret = (await readFile(file, "utf8")).trim()
  }
  if (!secret || !/^aac_[a-f0-9]{64}$/.test(secret)) throw new Error("Set ALOOK_ACCESS_CODE or use --access-code-file with an Automation access code")
  return secret
}

function serverOrigin(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("--server-url must be a server origin")
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("--server-url requires HTTPS, except for local development")
  return url.origin
}

function parseInput<T>(value: string, schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }): T {
  if (Buffer.byteLength(value, "utf8") > 131072) throw new Error("Automation request is too large")
  let input: unknown
  try { input = JSON.parse(value) } catch { throw new Error("Invalid request JSON") }
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
  return parsed.data
}

const InviteInput = z.strictObject({
  server: z.string().max(128).refine((value) => Boolean(parseNameAndTag(value)), "Use a full server handle"),
  friend: z.string().max(128).refine((value) => Boolean(parseNameAndTag(value)), "Use a full friend handle"),
})

export function registerUseCommands(program: Command, output: (value: { success: unknown }) => void) {
  const use = program.command("use").description("user Automation access: read lists, create resources and invite friends; no daemon connection required")
    .option("--access-code-file <path>", "read the code from a file instead of ALOOK_ACCESS_CODE")
    .option("--server-url <url>", "server origin (or ALOOK_SERVER_URL; defaults to production)")
    .exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  const request = async (path: string, body?: unknown) => {
    const options = use.opts<{ accessCodeFile?: string; serverUrl?: string }>()
    const origin = serverOrigin(options.serverUrl || process.env.ALOOK_SERVER_URL || "https://alook.ai")
    const secret = await readAccessCode(options.accessCodeFile)
    let response: Response
    try {
      response = await fetch(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(30_000),
      })
    } catch { throw new Error(body === undefined ? "Automation request failed" : "Automation request failed; the result may be unknown. Do not retry automatically.") }
    let raw: unknown
    try { raw = await response.json() } catch { throw new Error(`Automation returned HTTP ${response.status} without a valid result; do not retry automatically`) }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Automation returned an invalid result")
    const result = raw as Record<string, unknown>
    if (!response.ok) {
      const message = typeof result.error === "string" ? result.error.replaceAll(secret, "[redacted]") : `Automation failed: HTTP ${response.status}`
      throw Object.assign(new Error(message), {
        ...(typeof result.code === "string" ? { code: result.code.replaceAll(secret, "[redacted]") } : {}),
        ...(response.status === 429 ? { hint: `Retry after ${response.headers.get("Retry-After") ?? "the indicated"} seconds` } : {}),
      })
    }
    return { result, origin }
  }
  for (const kind of ["bot", "server", "machine", "friend"] as const) {
    const command = use.command(kind).description(`Automation ${kind} operations`).exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
    if (kind === "bot" || kind === "server") command.option("--create <json>", kind === "bot" ? "bot JSON: name, machineId, backendId, optional description/model/reasoningEffort" : "server JSON: name, optional description")
    if (kind !== "bot") command.option("--list", `list minimal ${kind} identities`)
    if (kind === "server") command.option("--invite <json>", "invite JSON: server and friend full handles")
    command.action(async () => {
      const options = command.opts<{ create?: string; list?: boolean; invite?: string }>()
      if ([options.create !== undefined, options.list === true, options.invite !== undefined].filter(Boolean).length !== 1) throw new Error("Choose exactly one action: --create, --list, or --invite")
      if (options.list) {
        const key = `${kind}s`
        const { result } = await request(kind === "friend" ? "/api/community/friends/accepted" : `/api/community/${key}`)
        const rows = result[key]
        if (!Array.isArray(rows)) throw new Error("Automation returned an invalid list")
        const list = rows.map((row: unknown) => {
          if (!row || typeof row !== "object" || !("name" in row) || typeof row.name !== "string") throw new Error("Automation returned an invalid identity")
          if (kind === "machine" && "id" in row && typeof row.id === "string") return { id: row.id, name: row.name }
          if (kind !== "machine" && "handle" in row && typeof row.handle === "string") return { name: row.name, handle: row.handle }
          throw new Error("Automation returned an invalid identity")
        })
        output({ success: { [key]: list } })
        return
      }
      if (options.invite !== undefined) {
        const input = parseInput(options.invite, InviteInput)
        const { result } = await request(`/api/community/servers/${encodeURIComponent(input.server)}/invites`, { friend: input.friend })
        const value = result.invitation
        if (!value || typeof value !== "object" || !("sent" in value) || value.sent !== true || !("server" in value) || typeof value.server !== "string" || !("friend" in value) || typeof value.friend !== "string") throw new Error("Automation returned an invalid invitation result; do not retry automatically")
        output({ success: { invitation: { server: value.server, friend: value.friend, sent: true } } })
        return
      }
      let body: unknown
      if (kind === "bot") {
        const { backendId, ...bot } = parseInput(options.create!, BotInput)
        body = { ...bot, runtime: backendId }
      } else body = parseInput(options.create!, ServerInput)
      const { result, origin } = await request(`/api/community/${kind}s`, body)
      const resource = result[kind]
      if (!resource || typeof resource !== "object" || !("id" in resource) || !("name" in resource) || !("discriminator" in resource) || typeof resource.id !== "string" || typeof resource.name !== "string" || typeof resource.discriminator !== "string") throw new Error("Automation returned an invalid result; do not retry automatically")
      output({ success: { [kind]: { id: resource.id, handle: `${resource.name}#${resource.discriminator}`,
        ...(kind === "server" ? { url: `${origin}/c/channels/${encodeURIComponent(resource.id)}` } : {}),
      } } })
    })
  }
}
