import type { z } from "zod"
import type { CommunityReadErrorSchema } from "@alook/shared"

export type CommunityApiErrorPayload = z.infer<typeof CommunityReadErrorSchema>["error"]

export function isAbortError(error: unknown): error is { name: "AbortError" } {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export class ApiError extends Error {
  status: number;
  details?: string[];

  constructor(message: string, status: number, details?: string[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export class CommunityApiError extends ApiError {
  readonly code: CommunityApiErrorPayload["code"]
  readonly retryable: CommunityApiErrorPayload["retryable"]

  constructor(error: CommunityApiErrorPayload, status: number, message = error.message) {
    super(message, status, error.details)
    this.code = error.code
    this.retryable = error.retryable
  }
}

export class UnauthorizedError extends ApiError {
  constructor() { super("Unauthorized", 401) }
}
