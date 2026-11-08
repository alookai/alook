import { OpenRouter } from "@openrouter/sdk"

import { TypeSafeClient } from "@typesafe-ai/sdk"

const REQUEST_TIMEOUT_MS = 1_500

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

type JevProviderEnv = Pick<RuntimeEnv,
  | "JEV_PROVIDER"
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

export function resolveJevProviderConfig(
  env: JevProviderEnv,
): ProviderConfig | null {
  const providerName = env.JEV_PROVIDER ?? "openrouter"
  if (providerName === "openrouter") {
    const baseURL = env.OPENROUTER_JEV_BASE_URL ?? "https://openrouter.ai"
    const apiKey = env.OPENROUTER_API_KEY ?? ""
    const model = env.OPENROUTER_JEV_MODEL ?? "typesafe/jev-1.13"
    return apiKey && model && validProviderBaseURL(baseURL)
      ? { providerName, apiKey, baseURL, model }
      : null
  }
  if (providerName === "typesafe") {
    const baseURL = env.TYPESAFE_JEV_BASE_URL ?? "https://api.typesafe.ai"
    const apiKey = env.TYPESAFE_API_KEY ?? ""
    const model = env.TYPESAFE_JEV_MODEL ?? "jev-1.13.0"
    return apiKey && model && validProviderBaseURL(baseURL)
      ? { providerName, apiKey, baseURL, model }
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
