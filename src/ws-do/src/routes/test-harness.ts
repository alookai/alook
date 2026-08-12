import { vi } from "vitest"
import { createMockDONamespace } from "../__mocks__/cf"

vi.mock("../ws-durable", () => ({
  WebSocketDurableObject: class { },
}))
vi.mock("../rate-limit-do", () => ({
  RateLimitDurableObject: class { },
}))

const sharedMocks = vi.hoisted(() => {
  const hashCredential = vi.fn(async (bearer: string) => `sha256:${bearer}`)
  const doNameFromHash = vi.fn((hash: string) => hash.slice(0, 32))
  const getActiveDoNamesForMachine = vi.fn(async (_db: unknown, _machineId: string) => [] as string[])
  const withD1Retry = vi.fn(async <T>(fn: () => Promise<T>, _opts?: unknown): Promise<T> => fn())
  const debug = vi.fn()
  const info = vi.fn()
  const warn = vi.fn()
  const error = vi.fn()
  const logger: Record<string, unknown> = { debug, info, warn, error }
  const child = vi.fn(() => logger)
  logger.child = child
  return {
    hashCredential,
    doNameFromHash,
    getActiveDoNamesForMachine,
    withD1Retry,
    logger,
    loggerChild: child,
    loggerDebug: debug,
    loggerInfo: info,
    loggerWarn: warn,
    loggerError: error,
  }
})

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createDb: () => ({}),
    createLogger: () => sharedMocks.logger,
    withD1Retry: <T>(fn: () => Promise<T>, opts?: unknown): Promise<T> => (
      sharedMocks.withD1Retry(fn, opts) as Promise<T>
    ),
    queries: {
      ...actual.queries,
      communityMachine: {
        ...actual.queries.communityMachine,
        hashCredential: (bearer: string) => sharedMocks.hashCredential(bearer),
        doNameFromHash: (hash: string) => sharedMocks.doNameFromHash(hash),
        getActiveDoNamesForMachine: (db: unknown, machineId: string) => (
          sharedMocks.getActiveDoNamesForMachine(db, machineId)
        ),
      },
    },
  }
})

export interface RouterTestContext {
  doMock: ReturnType<typeof createMockDONamespace>
  rateLimitMock: ReturnType<typeof createMockDONamespace>
  env: { WS_DO: DurableObjectNamespace; RATE_LIMIT_DO: DurableObjectNamespace }
}

export type RouterHandler = (typeof import("../index"))["default"]

export function getSharedMocks(): typeof sharedMocks {
  return sharedMocks
}

export function createRouterTestContext(): RouterTestContext {
  const doMock = createMockDONamespace()
  const rateLimitMock = createMockDONamespace()
  const env = {
    WS_DO: doMock.namespace,
    RATE_LIMIT_DO: rateLimitMock.namespace,
  } as unknown as RouterTestContext["env"]
  return { doMock, rateLimitMock, env }
}

export async function loadRouter(): Promise<RouterHandler> {
  return (await import("../index")).default
}
