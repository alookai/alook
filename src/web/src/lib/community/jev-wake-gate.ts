import { OpenRouter } from "@openrouter/sdk"
import { TypeSafeClient } from "@typesafe-ai/sdk"
import { createLogger, formatHandle } from "@alook/shared"

const log = createLogger({ service: "jev-wake-gate" })

const MAX_CANDIDATES = 100
const MAX_QUESTIONS_PER_BATCH = 20
const MAX_BATCH_BYTES = 128 * 1024
const MAX_CONTEXT_MESSAGES = 8
const MAX_CONTEXT_MESSAGE_BYTES = 1024
const MAX_CONTEXT_BYTES = 8 * 1024
const REQUEST_TIMEOUT_MS = 1_500
const TOTAL_TIMEOUT_MS = 2_000

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type JevEntry = string | JsonValue[] | { [key: string]: JsonValue }

type JevNoulQuestion = {
  type: "noul"
  instructions: JevEntry
}

type JevProviderRequest = {
  state: JevEntry
  questions: Record<string, JevNoulQuestion>
}

type JevProviderResponse = {
  answers: Record<string, unknown>
  model: string
  provider?: string
}

export type JevDecisionProvider = {
  name: "openrouter" | "typesafe"
  decide(
    request: JevProviderRequest,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<JevProviderResponse>
}

export type JevWakeCandidate = {
  botUserId: string
  name: string | null
  discriminator: string
  instruction: string
}

type JevWakeContextEntry = {
  text: string
  messageType: string
  author:
    | { kind: "bot"; handle: string }
    | { kind: "human"; handle: string }
  roles: Array<
    | "immediately_previous"
    | "reply_target"
    | "reply_ancestor"
    | "thread_opener"
    | "recent"
  >
  priority: number
  order: number
}

export type JevWakeGateInput = {
  messageId: string
  channel: {
    type: string
    name: string
    topic: string | null
  }
  message: {
    text: string
    type: string
    attachmentContentTypes: Array<string | null>
  }
  conversation: {
    available: boolean
    messages: JevWakeContextEntry[]
    truncated: boolean
  }
  candidates: JevWakeCandidate[]
}

type JevWakeEnv = Pick<RuntimeEnv,
  | "JEV_PROVIDER"
  | "JEV_WAKE_THRESHOLD"
  | "OPENROUTER_API_KEY"
  | "OPENROUTER_JEV_BASE_URL"
  | "OPENROUTER_JEV_MODEL"
  | "TYPESAFE_API_KEY"
  | "TYPESAFE_JEV_BASE_URL"
  | "TYPESAFE_JEV_MODEL"
>

export type ProviderConfig = {
  providerName: "openrouter" | "typesafe"
  apiKey: string
  baseURL: string
  model: string
  threshold: number
}

type GateDependencies = {
  createProvider?: (config: ProviderConfig) => JevDecisionProvider
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoder = new TextEncoder()
  if (encoder.encode(value).byteLength <= maxBytes) return { value, truncated: false }
  const suffix = "…"
  const contentBudget = maxBytes - encoder.encode(suffix).byteLength
  let result = ""
  let used = 0
  for (const character of value) {
    const size = encoder.encode(character).byteLength
    if (used + size > contentBudget) break
    result += character
    used += size
  }
  return { value: `${result}${suffix}`, truncated: true }
}

function makeConversation(input: JevWakeGateInput["conversation"]): {
  immediately_previous_message: JevEntry | null
  older_context: JevEntry[]
} {
  const prepared = input.messages
    .map((message) => {
      const text = truncateUtf8(message.text, MAX_CONTEXT_MESSAGE_BYTES)
      return {
        priority: message.priority,
        order: message.order,
        immediatelyPrevious: message.roles.includes("immediately_previous"),
        recent: message.roles.includes("recent"),
        wire: {
          author: message.author.handle,
          text: text.value,
        },
      }
    })
    .sort((left, right) => left.priority - right.priority || right.order - left.order)

  const selected: typeof prepared = []
  const findImmediate = (values: typeof prepared) =>
    values.find((item) => item.immediatelyPrevious)
      ?? values
        .filter((item) => item.recent)
        .sort((left, right) => right.order - left.order)[0]
      ?? null
  for (const candidate of prepared) {
    if (selected.length >= MAX_CONTEXT_MESSAGES) continue
    const next = [...selected, candidate]
    const immediate = findImmediate(next)
    const older = next
      .filter((item) => item !== immediate)
      .sort((left, right) => left.order - right.order)
      .map((item) => item.wire)
    if (byteLength({
      immediately_previous_message: immediate?.wire ?? null,
      older_context: older,
    }) > MAX_CONTEXT_BYTES) continue
    selected.push(candidate)
  }

  const immediate = findImmediate(selected)
  return {
    immediately_previous_message: immediate?.wire ?? null,
    older_context: selected
      .filter((item) => item !== immediate)
      .sort((left, right) => left.order - right.order)
      .map((item) => item.wire),
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

function validProviderBaseURL(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:"
      || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
  } catch {
    return false
  }
}

function resolveConfig(env: JevWakeEnv): ProviderConfig | null {
  const threshold = Number(env.JEV_WAKE_THRESHOLD ?? "0")
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) return null

  const providerName = env.JEV_PROVIDER ?? "openrouter"
  if (providerName === "openrouter") {
    const baseURL = env.OPENROUTER_JEV_BASE_URL ?? "https://openrouter.ai"
    const apiKey = env.OPENROUTER_API_KEY ?? ""
    const model = env.OPENROUTER_JEV_MODEL ?? "typesafe/jev-1.13"
    return apiKey && model && validProviderBaseURL(baseURL)
      ? { providerName, apiKey, baseURL, model, threshold }
      : null
  }
  if (providerName === "typesafe") {
    const baseURL = env.TYPESAFE_JEV_BASE_URL ?? "https://api.typesafe.ai"
    const apiKey = env.TYPESAFE_API_KEY ?? ""
    const model = env.TYPESAFE_JEV_MODEL ?? "jev-1.13.0"
    return apiKey && model && validProviderBaseURL(baseURL)
      ? { providerName, apiKey, baseURL, model, threshold }
      : null
  }
  return null
}

function createOpenRouterProvider(config: ProviderConfig): JevDecisionProvider {
  const client = new OpenRouter({
    apiKey: config.apiKey,
    httpReferer: "https://alook.ai",
    appTitle: "Alook",
    retryConfig: { strategy: "none" },
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  return {
    name: "openrouter",
    async decide(request, options) {
      const response = await client.alpha.decisions.create(
        {
          decisionsRequest: {
            model: config.model,
            state: request.state,
            questions: request.questions,
          },
        },
        {
          serverURL: config.baseURL,
          timeoutMs: options.timeoutMs,
          retries: { strategy: "none" },
          signal: options.signal,
        },
      )
      return {
        answers: response.answers,
        model: response.model,
        ...(response.provider ? { provider: response.provider } : {}),
      }
    },
  }
}

function createTypeSafeProvider(config: ProviderConfig): JevDecisionProvider {
  const client = new TypeSafeClient({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultModel: config.model,
    logLevel: "off",
    retry: { maxRetries: 0 },
    timeout: REQUEST_TIMEOUT_MS,
  })
  return {
    name: "typesafe",
    async decide(request, options) {
      const response = await client.systemOne(
        {
          model: config.model,
          state: request.state,
          questions: request.questions,
        },
        {
          timeout: options.timeoutMs,
          retry: { maxRetries: 0 },
          signal: options.signal,
        },
      )
      return { answers: response.answers, model: response.model, provider: "TypeSafe" }
    },
  }
}

export function createJevDecisionProvider(config: ProviderConfig): JevDecisionProvider {
  if (!validProviderBaseURL(config.baseURL)) {
    throw new Error("JEV provider base URL must use HTTPS or loopback HTTP")
  }
  return config.providerName === "openrouter"
    ? createOpenRouterProvider(config)
    : createTypeSafeProvider(config)
}

function makeState(input: JevWakeGateInput): JevEntry {
  const conversation = makeConversation(input.conversation)
  return {
    current_message: input.message.text,
    ...(input.message.type === "default"
      ? {}
      : { current_message_type: input.message.type }),
    ...(input.message.attachmentContentTypes.length === 0
      ? {}
      : { attachment_content_types: input.message.attachmentContentTypes }),
    ...conversation,
  }
}

function makeQuestion(
  candidate: JevWakeGateInput["candidates"][number],
): JevNoulQuestion {
  return {
    type: "noul",
    instructions: {
      question: "Should this candidate act now in response to state.current_message?",
      candidate: {
        handle: formatHandle(candidate.name ?? "", candidate.discriminator),
        role: candidate.instruction,
      },
      decision_rule: "Determine recipients from state.current_message first; new recipients replace earlier recipients. An unqualified whole-audience phrase includes every candidate, while a phrase qualified by a named group includes only that group's members. Use state.immediately_previous_message to resolve a context-dependent answer or approval. Use state.older_context only when current_message refers to a named person, group, or item. Return yes only when this candidate is an intended recipient, the owner of the pending request being answered, or the clear owner of an unaddressed task. Mere relevance or ability to help is no.",
    },
  }
}

function readProbability(answer: unknown): number | null {
  if (!answer || typeof answer !== "object") return null
  const record = answer as Record<string, unknown>
  if (record.type !== "noul" || typeof record.noul !== "number") return null
  return Number.isFinite(record.noul) && record.noul >= 0 && record.noul <= 1
    ? record.noul
    : null
}

function errorCategory(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "timeout"
  if (error instanceof Error && /timeout|timed out/i.test(`${error.name} ${error.message}`)) {
    return "timeout"
  }
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown; statusCode?: unknown }).status
      ?? (error as { statusCode?: unknown }).statusCode
    if (typeof status === "number") return `http_${status}`
  }
  return "provider_error"
}

export async function selectJevWakeCandidates(
  input: JevWakeGateInput,
  env: JevWakeEnv,
  dependencies: GateDependencies = {},
): Promise<JevWakeCandidate[]> {
  if (input.candidates.length === 0 || input.channel.type === "dm") {
    return input.candidates
  }
  if (!input.conversation.available) {
    log.warn("jev_wake_gate_fail_open", {
      messageId: input.messageId,
      reason: "context_unavailable",
      candidateCount: input.candidates.length,
    })
    return input.candidates
  }
  if (input.candidates.length > MAX_CANDIDATES) {
    log.warn("jev_wake_gate_fail_open", {
      messageId: input.messageId,
      reason: "candidate_limit",
      candidateCount: input.candidates.length,
    })
    return input.candidates
  }

  const config = resolveConfig(env)
  if (!config) {
    log.warn("jev_wake_gate_fail_open", {
      messageId: input.messageId,
      reason: "invalid_or_missing_config",
      candidateCount: input.candidates.length,
    })
    return input.candidates
  }

  let provider: JevDecisionProvider
  try {
    provider = (dependencies.createProvider ?? createJevDecisionProvider)(config)
  } catch {
    log.warn("jev_wake_gate_fail_open", {
      messageId: input.messageId,
      provider: config.providerName,
      model: config.model,
      reason: "provider_initialization",
      candidateCount: input.candidates.length,
    })
    return input.candidates
  }
  const state = makeState(input)
  const batches = chunks(input.candidates, MAX_QUESTIONS_PER_BATCH).map((batch, batchIndex) => {
    const mapping = new Map<string, JevWakeGateInput["candidates"][number]>()
    const questions = Object.fromEntries(batch.map((candidate) => {
      const key = formatHandle(candidate.name ?? "", candidate.discriminator)
      mapping.set(key, candidate)
      return [key, makeQuestion(candidate)]
    }))
    return {
      batch,
      batchIndex,
      mapping,
      request: { state, questions },
    }
  })
  for (const prepared of batches) {
    if (byteLength({ model: config.model, ...prepared.request }) <= MAX_BATCH_BYTES) continue
    log.warn("jev_wake_gate_fail_open", {
      messageId: input.messageId,
      provider: provider.name,
      reason: "payload_limit",
      batchIndex: prepared.batchIndex,
      candidateCount: prepared.batch.length,
    })
    return input.candidates
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  const startedAt = Date.now()

  try {
    const selections = await Promise.all(batches.map(async ({ batch, batchIndex, mapping, request }) => {
      try {
        const response = await provider.decide(request, {
          signal: controller.signal,
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
        const accepted: JevWakeGateInput["candidates"] = []
        let valid = true
        for (const [key, candidate] of mapping) {
          const probability = readProbability(response.answers[key])
          if (probability === null) {
            log.warn("jev_wake_gate_fail_open", {
              messageId: input.messageId,
              botUserId: candidate.botUserId,
              provider: provider.name,
              model: response.model,
              reason: "invalid_answer",
              batchIndex,
            })
            valid = false
            continue
          }
          const wouldPass = probability >= config.threshold
          log.info("jev_wake_decision", {
            messageId: input.messageId,
            botUserId: candidate.botUserId,
            provider: provider.name,
            upstreamProvider: response.provider,
            model: response.model,
            pWake: probability,
            threshold: config.threshold,
            wouldPass,
          })
          if (wouldPass) accepted.push(candidate)
        }
        return valid ? { ok: true as const, accepted } : { ok: false as const }
      } catch (error) {
        log.warn("jev_wake_gate_fail_open", {
          messageId: input.messageId,
          provider: provider.name,
          model: config.model,
          reason: errorCategory(error),
          batchIndex,
          candidateCount: batch.length,
        })
        return { ok: false as const }
      }
    }))
    const narrowed = selections.every((selection) => selection.ok)
      ? selections.flatMap((selection) => selection.accepted)
      : []
    const failOpenReason = selections.some((selection) => !selection.ok)
      ? "batch_failure"
      : narrowed.length === 0
        ? "empty_selection"
        : undefined
    const result = failOpenReason ? input.candidates : narrowed
    log.info("jev_wake_gate_complete", {
      messageId: input.messageId,
      provider: provider.name,
      model: config.model,
      candidateCount: input.candidates.length,
      selectedCount: result.length,
      narrowedCount: narrowed.length,
      batchCount: batches.length,
      ...(failOpenReason ? { failOpenReason } : {}),
      durationMs: Date.now() - startedAt,
    })
    return result
  } finally {
    clearTimeout(timer)
  }
}
