import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  openRouterConstructor: vi.fn(),
  openRouterCreate: vi.fn(),
  typeSafeConstructor: vi.fn(),
  typeSafeSystemOne: vi.fn(),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      child() { return this },
      debug: vi.fn(),
      error: vi.fn(),
      info: (...args: unknown[]) => mocks.logInfo(...args),
      warn: (...args: unknown[]) => mocks.logWarn(...args),
    }),
  }
})

vi.mock("@openrouter/sdk", () => ({
  OpenRouter: vi.fn(function OpenRouter(options: unknown) {
    mocks.openRouterConstructor(options)
    return { alpha: { decisions: { create: mocks.openRouterCreate } } }
  }),
}))

vi.mock("@typesafe-ai/sdk", () => ({
  TypeSafeClient: vi.fn(function TypeSafeClient(options: unknown) {
    mocks.typeSafeConstructor(options)
    return { systemOne: mocks.typeSafeSystemOne }
  }),
}))

import { createJevDecisionProvider, type ProviderConfig } from "./jev-decision-provider"

describe("JEV provider adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("translates the provider-neutral request to OpenRouter Decisions", async () => {
    mocks.openRouterCreate.mockResolvedValue({
      answers: { bot_0: { type: "noul", noul: 0.8 } },
      model: "typesafe/jev-1.13",
      provider: "TypeSafe",
    })
    const config: ProviderConfig = {
      providerName: "openrouter",
      apiKey: "secret",
      baseURL: "https://openrouter.test",
      model: "typesafe/jev-1.13",
      threshold: 0,
    }
    const adapter = createJevDecisionProvider(config)
    const request = {
      state: { message: "hello" },
      questions: {
        bot_0: {
          type: "noul" as const,
          instructions: "Wake?",
        },
      },
    }
    await expect(adapter.decide(request, {
      signal: new AbortController().signal,
      timeoutMs: 321,
    })).resolves.toMatchObject({
      answers: { bot_0: { type: "noul", noul: 0.8 } },
      model: "typesafe/jev-1.13",
      provider: "TypeSafe",
    })
    expect(mocks.openRouterConstructor).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "secret",
      retryConfig: { strategy: "none" },
    }))
    expect(mocks.openRouterCreate).toHaveBeenCalledWith(
      { decisionsRequest: { model: config.model, ...request } },
      expect.objectContaining({
        serverURL: config.baseURL,
        timeoutMs: 321,
        retries: { strategy: "none" },
      }),
    )
  })

  it("translates the provider-neutral request to TypeSafe System One", async () => {
    mocks.typeSafeSystemOne.mockResolvedValue({
      answers: { bot_0: { type: "noul", noul: 0.7 } },
      model: "jev-1.13.0",
    })
    const config: ProviderConfig = {
      providerName: "typesafe",
      apiKey: "secret",
      baseURL: "https://typesafe.test",
      model: "jev-1.13.0",
      threshold: 0,
    }
    const adapter = createJevDecisionProvider(config)
    const request = {
      state: { message: "hello" },
      questions: {
        bot_0: {
          type: "noul" as const,
          instructions: "Wake?",
        },
      },
    }
    await expect(adapter.decide(request, {
      signal: new AbortController().signal,
      timeoutMs: 321,
    })).resolves.toMatchObject({
      answers: { bot_0: { type: "noul", noul: 0.7 } },
      model: "jev-1.13.0",
      provider: "TypeSafe",
    })
    expect(mocks.typeSafeConstructor).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "secret",
      baseURL: config.baseURL,
      defaultModel: config.model,
      logLevel: "off",
      retry: { maxRetries: 0 },
    }))
    expect(mocks.typeSafeSystemOne).toHaveBeenCalledWith(
      { model: config.model, ...request },
      expect.objectContaining({ timeout: 321, retry: { maxRetries: 0 } }),
    )
  })

  it.each(["openrouter", "typesafe"] as const)(
    "rejects insecure non-loopback HTTP for the %s adapter",
    (providerName) => {
      expect(() => createJevDecisionProvider({
        providerName,
        apiKey: "secret",
        baseURL: "http://provider.example.test",
        model: "jev-test",
        threshold: 0,
      })).toThrow("JEV provider base URL must use HTTPS or loopback HTTP")
    },
  )
})
