const reasons: Record<string, string> = {
  PROVIDER_NOT_FOUND: "Provider not found",
  ID_TOKEN_NOT_SUPPORTED: "ID token not supported",
  INVALID_TOKEN: "Invalid token",
  FAILED_TO_GET_USER_INFO: "Failed to get user info",
  USER_EMAIL_NOT_FOUND: "User email not found",
  EMAIL_NOT_VERIFIED: "Email not verified",
  INVALID_EMAIL: "Invalid email",
  INVALID_EMAIL_OR_PASSWORD: "Invalid email or password",
  INVALID_OTP: "Invalid OTP",
  OTP_EXPIRED: "OTP expired",
  TOO_MANY_ATTEMPTS: "Too many attempts",
  USER_NOT_FOUND: "User not found",
  FAILED_TO_CREATE_USER: "Failed to create user",
  FAILED_TO_CREATE_SESSION: "Failed to create session",
  FAILED_TO_CREATE_VERIFICATION: "Unable to create verification",
  INVALID_ORIGIN: "Invalid origin",
  MISSING_OR_NULL_ORIGIN: "Missing or null Origin",
  INVALID_CALLBACK_URL: "Invalid callback URL",
  INVALID_REDIRECT_URL: "Invalid redirect URL",
  INVALID_ERROR_CALLBACK_URL: "Invalid error callback URL",
  INVALID_NEW_USER_CALLBACK_URL: "Invalid new user callback URL",
  CALLBACK_URL_REQUIRED: "Callback URL is required",
  VALIDATION_ERROR: "Validation error",
  RATE_LIMIT_EXCEEDED: "Too many requests",
  INTERNAL_SERVER_ERROR: "Internal server error",
}

export function authFailureParams(error: unknown): Record<string, string> {
  const input = error && typeof error === "object" ? error as Record<string, unknown> : {}
  const status = typeof input.status === "number" && Number.isInteger(input.status) && input.status >= 100 && input.status <= 599 ? input.status : undefined
  const code = typeof input.code === "string" && Object.hasOwn(reasons, input.code) ? input.code : undefined
  const network = input.name === "TypeError" && ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."].includes(String(input.message))
  const errorCode = code ?? (status === 429 ? "RATE_LIMIT_EXCEEDED" : network ? "NETWORK_ERROR" : status ? "HTTP_ERROR" : "UNKNOWN_ERROR")
  return {
    error_code: errorCode,
    error_reason: reasons[errorCode] ?? (network ? "Network request failed" : status ? `HTTP ${status}` : "No recognized error detail returned"),
    ...(status ? { http_status: String(status) } : {}),
  }
}
