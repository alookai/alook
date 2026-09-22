export type PushProvider = "apns" | "fcm"

export type PushProviderStage =
  | "configuration"
  | "decrypt"
  | "credential_fingerprint"
  | "key_import"
  | "sign"
  | "oauth_fetch"
  | "delivery_data_fetch"
  | "delivery_data_parse"
  | "provider_send"

const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "DataError",
  "DOMException",
  "Error",
  "InvalidAccessError",
  "NetworkError",
  "NotSupportedError",
  "OperationError",
  "PushProviderError",
  "RangeError",
  "SyntaxError",
  "TypeError",
])

const SAFE_HTTP_STATUSES = new Set([
  400,
  401,
  403,
  404,
  405,
  408,
  409,
  410,
  413,
  429,
  500,
  502,
  503,
  504,
])

const HTTP_STAGES = new Set<PushProviderStage>([
  "oauth_fetch",
  "delivery_data_fetch",
  "provider_send",
])

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "unknown"
  return SAFE_ERROR_NAMES.has(error.name) ? error.name : "unknown"
}

export class PushProviderError extends Error {
  readonly errorName: string

  constructor(
    readonly provider: PushProvider,
    readonly stage: PushProviderStage,
    readonly status?: number,
    readonly reason?: string,
    errorName = "PushProviderError",
  ) {
    super(`${provider} failed at ${stage}`)
    this.name = "PushProviderError"
    this.errorName = SAFE_ERROR_NAMES.has(errorName) ? errorName : "unknown"
  }
}

export async function runPushProviderStage<T>(
  provider: PushProvider,
  stage: PushProviderStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof PushProviderError) throw error
    throw new PushProviderError(provider, stage, undefined, undefined, safeErrorName(error))
  }
}

export function getPushProviderDiagnostic(
  error: unknown,
  fallbackProvider: PushProvider,
  fallbackStage: PushProviderStage,
): {
  provider: PushProvider
  stage: PushProviderStage
  errorName: string
  httpStatus?: number
} {
  const providerError = error instanceof PushProviderError ? error : undefined
  const status = providerError?.status
  const stage = providerError?.stage ?? fallbackStage
  return {
    provider: providerError?.provider ?? fallbackProvider,
    stage,
    errorName: providerError?.errorName ?? safeErrorName(error),
    ...(
      status !== undefined
      && HTTP_STAGES.has(stage)
      && SAFE_HTTP_STATUSES.has(status)
        ? { httpStatus: status }
        : {}
    ),
  }
}
