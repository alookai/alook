// Independent iframe, origin, and host-protocol policy for Open Artifact pages.
// Kept strictly separate from `html-preview-policy.ts` so HTML attachment
// sandboxing rules are never relaxed.
export const OPEN_ARTIFACT_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"

export const OPEN_ARTIFACT_FRAME_ALLOW =
  "clipboard-read; clipboard-write; fullscreen"

export const OPEN_ARTIFACT_HOST_PROTOCOL = 1 as const
const MAX_HOST_TEXT = 8_000

export type OpenArtifactThemeScheme = "light" | "dark"

export type OpenArtifactSavedState =
  | "saved"
  | "saving"
  | "unsaved"
  | "reconnecting"
  | "readonly"

const VALID_SAVED_STATES: readonly OpenArtifactSavedState[] = [
  "saved",
  "saving",
  "unsaved",
  "reconnecting",
  "readonly",
]

export type OpenArtifactHostHello = {
  openArtifact: "host_hello"
  protocol: typeof OPEN_ARTIFACT_HOST_PROTOCOL
  caps: {
    toolbar: true
    switcher: true
  }
  theme: {
    scheme: OpenArtifactThemeScheme
  }
}

export type OpenArtifactShellMessage =
  | {
      openArtifact: "shell_hello"
      version: string
      protocol: number
      artifact: string
      id: string
      title: string
      type: string
    }
  | { openArtifact: "shell_ready"; artifact: string }
  | { openArtifact: "close" }
  | { openArtifact: "place"; artifact: string; hash: string }
  | { openArtifact: "saved"; state: OpenArtifactSavedState | null; leaveLosesWork: boolean }
  | { openArtifact: "comment_summon"; text: string }
  | { openArtifact: "open_external"; url: string }

export function normalizeAllowedOrigin(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes("*")) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
  if (parsed.origin === "null") return null
  if (parsed.username || parsed.password) return null
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null
  return parsed.origin
}

export function normalizeAllowedOrigins(origins: readonly string[]): string[] {
  const normalized = new Set<string>()
  for (const raw of origins) {
    const origin = normalizeAllowedOrigin(raw)
    if (origin) normalized.add(origin)
  }
  return Array.from(normalized)
}

export type VerifiedOpenArtifactEmbed =
  | { ok: true; url: string; origin: string }
  | { ok: false; reason: "invalid-url" | "untrusted-origin" }

export function verifyOpenArtifactEmbedUrl(
  candidateUrl: string,
  allowedOrigins: readonly string[],
): VerifiedOpenArtifactEmbed {
  const trimmed = candidateUrl.trim()
  if (!trimmed) return { ok: false, reason: "invalid-url" }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: "invalid-url" }
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "invalid-url" }
  }
  if (parsed.origin === "null" || parsed.username || parsed.password) {
    return { ok: false, reason: "invalid-url" }
  }
  const allowlist = new Set(normalizeAllowedOrigins(allowedOrigins))
  if (!allowlist.has(parsed.origin)) {
    return { ok: false, reason: "untrusted-origin" }
  }
  return { ok: true, url: parsed.toString(), origin: parsed.origin }
}

export function isSafeExternalHttpUrl(candidateUrl: string): string | null {
  const trimmed = candidateUrl.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
  if (parsed.origin === "null" || parsed.username || parsed.password) return null
  return parsed.toString()
}

export function buildOpenArtifactHostHello(
  scheme: OpenArtifactThemeScheme,
): OpenArtifactHostHello {
  return {
    openArtifact: "host_hello",
    protocol: OPEN_ARTIFACT_HOST_PROTOCOL,
    caps: {
      toolbar: true,
      switcher: true,
    },
    theme: { scheme },
  }
}

function hostText(value: unknown, max = MAX_HOST_TEXT): string {
  return typeof value === "string" ? value.slice(0, max) : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseTrustedShellMessage(
  event: Pick<MessageEvent<unknown>, "origin" | "source" | "data">,
  expectedOrigin: string,
  frameWindow: MessageEventSource | null,
): OpenArtifactShellMessage | null {
  if (!frameWindow || event.source !== frameWindow) return null
  if (event.origin !== expectedOrigin) return null
  if (!isRecord(event.data)) return null
  const data = event.data
  switch (data.openArtifact) {
    case "shell_hello":
      return {
        openArtifact: "shell_hello",
        version: hostText(data.version, 64),
        protocol: Number.isInteger(data.protocol) ? (data.protocol as number) : 1,
        artifact: hostText(data.artifact, 200),
        id: hostText(data.id, 100),
        title: hostText(data.title, 500),
        type: hostText(data.type, 100),
      }
    case "shell_ready":
      return {
        openArtifact: "shell_ready",
        artifact: hostText(data.artifact, 200),
      }
    case "close":
      return { openArtifact: "close" }
    case "place":
      return {
        openArtifact: "place",
        artifact: hostText(data.artifact, 200),
        hash: hostText(data.hash, 2000),
      }
    case "comment_summon":
      return {
        openArtifact: "comment_summon",
        text: hostText(data.text),
      }
    case "open_external": {
      const safeUrl = isSafeExternalHttpUrl(hostText(data.url, 4000))
      return safeUrl ? { openArtifact: "open_external", url: safeUrl } : null
    }
    case "saved": {
      const rawState = data.state
      const state = rawState === null || rawState === undefined
        ? null
        : VALID_SAVED_STATES.includes(rawState as OpenArtifactSavedState)
          ? (rawState as OpenArtifactSavedState)
          : undefined
      if (state === undefined) return null
      return {
        openArtifact: "saved",
        state,
        leaveLosesWork: data.leaveLosesWork === true,
      }
    }
    default:
      return null
  }
}
