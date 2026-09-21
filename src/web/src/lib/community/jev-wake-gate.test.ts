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

import {
  createJevDecisionProvider,
  selectJevWakeCandidates,
  type JevDecisionProvider,
  type JevWakeGateInput,
  type ProviderConfig,
} from "./jev-wake-gate"

const candidate = {
  botUserId: "bot_1",
  name: "Jarvis",
  discriminator: "9866",
  instruction: "Own release coordination",
  directlyMentioned: true,
  isReplyTarget: false,
}

const input: JevWakeGateInput = {
  messageId: "msg_1",
  channel: { type: "text", name: "future", topic: "Product planning" },
  message: {
    text: "Please review this",
    type: "default",
    replyPreview: null,
    broadcastMention: false,
    attachmentContentTypes: [],
  },
  candidates: [candidate],
}

const openRouterEnv = {
  JEV_PROVIDER: "openrouter",
  JEV_WAKE_THRESHOLD: "0",
  OPENROUTER_API_KEY: "test-key",
  OPENROUTER_JEV_BASE_URL: "https://openrouter.test",
  OPENROUTER_JEV_MODEL: "typesafe/jev-1.13",
}

function provider(
  probabilities: number[],
  inspect?: (request: unknown) => void,
): JevDecisionProvider {
  let call = 0
  return {
    name: "openrouter",
    async decide(request) {
      inspect?.(request)
      const answers = Object.fromEntries(Object.keys(request.questions).map((key) => [
        key,
        { type: "noul", noul: probabilities[call++] ?? 0 },
      ]))
      return { answers, model: "typesafe/jev-1.13", provider: "TypeSafe" }
    },
  }
}

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
          criteria: { true: "yes", false: "no" },
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
          criteria: { true: "yes", false: "no" },
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

describe("selectJevWakeCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("passes p=0 at the initial inclusive threshold and builds minimal per-bot questions", async () => {
    let request: unknown
    const selected = await selectJevWakeCandidates(input, openRouterEnv, {
      createProvider: () => provider([0], (value) => { request = value }),
    })
    expect(selected).toEqual([candidate])
    expect(request).toMatchObject({
      state: {
        message: {
          text: "Please review this",
          channel_kind: "text",
          attachment_count: 0,
        },
      },
      questions: {
        bot_0: {
          type: "noul",
          instructions: {
            bot: {
              name: "Jarvis",
              discriminator: "9866",
              standing_responsibility: "Own release coordination",
              directly_mentioned: true,
              is_reply_target: false,
            },
          },
        },
      },
    })
    expect(JSON.stringify(request)).not.toContain("bot_1")
  })

  it("filters below-threshold answers while failing open only invalid answers", async () => {
    const candidates = [
      candidate,
      { ...candidate, botUserId: "bot_2", discriminator: "0002" },
      { ...candidate, botUserId: "bot_3", discriminator: "0003" },
    ]
    const customProvider: JevDecisionProvider = {
      name: "openrouter",
      async decide() {
        return {
          model: "typesafe/jev-1.13",
          answers: {
            bot_0: { type: "noul", noul: 0.49 },
            bot_1: { type: "noul", noul: 0.5 },
            bot_2: { type: "choice", noul: 1 },
          },
        }
      },
    }
    const selected = await selectJevWakeCandidates(
      { ...input, candidates },
      { ...openRouterEnv, JEV_WAKE_THRESHOLD: "0.5" },
      { createProvider: () => customProvider },
    )
    expect(selected.map((item) => item.botUserId)).toEqual(["bot_2", "bot_3"])
  })

  it.each([
    { type: "noul", noul: Number.NaN },
    { type: "noul", noul: -0.01 },
    { type: "noul", noul: 1.01 },
    { type: "choice", noul: 1 },
    undefined,
  ])("fails open for invalid answers", async (answer) => {
    const invalidProvider: JevDecisionProvider = {
      name: "openrouter",
      async decide() {
        return { model: "typesafe/jev-1.13", answers: { bot_0: answer } }
      },
    }
    await expect(selectJevWakeCandidates(input, openRouterEnv, {
      createProvider: () => invalidProvider,
    })).resolves.toEqual([candidate])
  })

  it("bypasses only DMs and fails open for missing configuration", async () => {
    const createProvider = vi.fn(() => provider([1]))
    await expect(selectJevWakeCandidates(
      { ...input, channel: { ...input.channel, type: "dm" } },
      {},
      { createProvider },
    )).resolves.toEqual([candidate])
    expect(createProvider).not.toHaveBeenCalled()

    await expect(selectJevWakeCandidates(input, {}, { createProvider }))
      .resolves.toEqual([candidate])
    expect(createProvider).not.toHaveBeenCalled()
  })

  it("fails open when provider initialization throws", async () => {
    await expect(selectJevWakeCandidates(input, openRouterEnv, {
      createProvider: () => { throw new Error("bad sdk initialization") },
    })).resolves.toEqual([candidate])
    expect(mocks.logWarn).toHaveBeenCalledWith("jev_wake_gate_fail_open", expect.objectContaining({
      reason: "provider_initialization",
    }))
  })

  it.each([
    { JEV_PROVIDER: "unknown", OPENROUTER_API_KEY: "test-key" },
    { ...openRouterEnv, JEV_WAKE_THRESHOLD: "NaN" },
    { ...openRouterEnv, JEV_WAKE_THRESHOLD: "-0.1" },
    { ...openRouterEnv, OPENROUTER_JEV_BASE_URL: "not-a-url" },
    { ...openRouterEnv, OPENROUTER_JEV_BASE_URL: "http://openrouter.example.test" },
    {
      JEV_PROVIDER: "typesafe",
      TYPESAFE_API_KEY: "test-key",
      TYPESAFE_JEV_BASE_URL: "http://typesafe.example.test",
      TYPESAFE_JEV_MODEL: "jev-1.13.0",
    },
  ])("fails open for invalid provider configuration", async (env) => {
    const createProvider = vi.fn(() => provider([1]))
    await expect(selectJevWakeCandidates(input, env, { createProvider }))
      .resolves.toEqual([candidate])
    expect(createProvider).not.toHaveBeenCalled()
  })

  it.each([
    {
      env: { ...openRouterEnv, OPENROUTER_JEV_BASE_URL: "http://localhost:8787" },
      expectedBaseURL: "http://localhost:8787",
    },
    {
      env: {
        JEV_PROVIDER: "typesafe",
        JEV_WAKE_THRESHOLD: "0",
        TYPESAFE_API_KEY: "test-key",
        TYPESAFE_JEV_BASE_URL: "http://127.0.0.1:8787",
        TYPESAFE_JEV_MODEL: "jev-1.13.0",
      },
      expectedBaseURL: "http://127.0.0.1:8787",
    },
  ])("allows loopback HTTP for $env.JEV_PROVIDER", async ({ env, expectedBaseURL }) => {
    const createProvider = vi.fn(() => provider([1]))
    await expect(selectJevWakeCandidates(input, env, { createProvider }))
      .resolves.toEqual([candidate])
    expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerName: env.JEV_PROVIDER,
      baseURL: expectedBaseURL,
    }))
  })

  it.each([
    [new DOMException("aborted", "AbortError"), "timeout"],
    [new Error("request timed out"), "timeout"],
    [{ statusCode: 429 }, "http_429"],
    [{ status: 529 }, "http_529"],
    [new Error("connection failed"), "provider_error"],
  ])("categorizes provider failures without exposing their bodies", async (error, reason) => {
    const failing: JevDecisionProvider = {
      name: "openrouter",
      async decide() { throw error },
    }
    await expect(selectJevWakeCandidates(input, openRouterEnv, {
      createProvider: () => failing,
    })).resolves.toEqual([candidate])
    expect(mocks.logWarn).toHaveBeenCalledWith("jev_wake_gate_fail_open", expect.objectContaining({
      reason,
    }))
  })

  it("aborts an in-flight provider batch at the total deadline and fails open", async () => {
    vi.useFakeTimers()
    try {
      const hanging: JevDecisionProvider = {
        name: "openrouter",
        decide(_request, options) {
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"))
            }, { once: true })
          })
        },
      }
      const selection = selectJevWakeCandidates(input, openRouterEnv, {
        createProvider: () => hanging,
      })

      await vi.advanceTimersByTimeAsync(2_000)

      await expect(selection).resolves.toEqual([candidate])
      expect(mocks.logWarn).toHaveBeenCalledWith("jev_wake_gate_fail_open", expect.objectContaining({
        reason: "timeout",
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it("evaluates non-DM blank and attachment-only messages with one question per bot", async () => {
    const requests: unknown[] = []
    const candidates = [
      candidate,
      {
        ...candidate,
        botUserId: "bot_2",
        name: "Samara",
        discriminator: "8738",
        instruction: "",
        directlyMentioned: false,
        isReplyTarget: true,
      },
    ]
    const selected = await selectJevWakeCandidates({
      ...input,
      channel: { ...input.channel, type: "thread" },
      message: {
        ...input.message,
        text: "",
        type: "system",
        broadcastMention: true,
        attachmentContentTypes: ["image/png"],
      },
      candidates,
    }, openRouterEnv, {
      createProvider: () => provider([1, 1], (request) => requests.push(request)),
    })
    expect(selected).toEqual(candidates)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      state: { message: { text: "", attachment_content_types: ["image/png"] } },
      questions: {
        bot_0: { instructions: { bot: { directly_mentioned: true, is_reply_target: false } } },
        bot_1: { instructions: { bot: { directly_mentioned: false, is_reply_target: true } } },
      },
    })
  })

  it("batches 21 candidates into 20 plus 1", async () => {
    const decide = vi.fn(async (request) => ({
      model: "typesafe/jev-1.13",
      answers: Object.fromEntries(Object.keys(request.questions).map((key) => [
        key,
        { type: "noul", noul: 1 },
      ])),
    }))
    const candidates = Array.from({ length: 21 }, (_, index) => ({
      ...candidate,
      botUserId: `bot_${index + 1}`,
      discriminator: String(index).padStart(4, "0"),
    }))
    const selected = await selectJevWakeCandidates(
      { ...input, candidates },
      openRouterEnv,
      { createProvider: () => ({ name: "openrouter", decide }) },
    )
    expect(selected).toHaveLength(21)
    expect(decide).toHaveBeenCalledTimes(2)
    expect(Object.keys(decide.mock.calls[0]![0].questions)).toHaveLength(20)
    expect(Object.keys(decide.mock.calls[1]![0].questions)).toHaveLength(1)
  })

  it("fails open before provider calls for candidate and payload limits", async () => {
    const decide = vi.fn()
    const createProvider = () => ({ name: "openrouter" as const, decide })
    const overCandidateLimit = Array.from({ length: 101 }, (_, index) => ({
      ...candidate,
      botUserId: `bot_${index}`,
    }))
    await expect(selectJevWakeCandidates(
      { ...input, candidates: overCandidateLimit },
      openRouterEnv,
      { createProvider },
    )).resolves.toEqual(overCandidateLimit)

    const oversized = [{ ...candidate, instruction: "x".repeat(130 * 1024) }]
    await expect(selectJevWakeCandidates(
      { ...input, candidates: oversized },
      openRouterEnv,
      { createProvider },
    )).resolves.toEqual(oversized)
    expect(decide).not.toHaveBeenCalled()
  })

  it("fails open on provider errors without logging private content or keys", async () => {
    const failing: JevDecisionProvider = {
      name: "openrouter",
      async decide() {
        throw new Error("provider body leaked Please review this test-key")
      },
    }
    await expect(selectJevWakeCandidates(input, openRouterEnv, {
      createProvider: () => failing,
    })).resolves.toEqual([candidate])
    const logs = JSON.stringify([...mocks.logInfo.mock.calls, ...mocks.logWarn.mock.calls])
    expect(logs).not.toContain("Please review this")
    expect(logs).not.toContain("Own release coordination")
    expect(logs).not.toContain("test-key")
    expect(logs).not.toContain("provider body leaked")
  })
})
