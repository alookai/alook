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

export class UnauthorizedError extends ApiError {
  constructor() { super("Unauthorized", 401) }
}
