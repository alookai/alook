import { createStore } from "@tanstack/store";
import { ApiError, UnauthorizedError, isAbortError } from "@/lib/errors";

const API_BASE = "";
export const ACCOUNT_DELETED_SIGN_IN_PATH = "/sign-in?account_deleted=1";

const MOCK_NETWORK_ENABLED = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_MOCK_NETWORK === "true";
const MOCK_NETWORK_DELAY_MS = parseInt(process.env.NEXT_PUBLIC_MOCK_NETWORK_DELAY_MS || "300", 10) || 300;
let mockNetworkLogged = false;
const accountDeletionAuthTransitions = createStore(new Map<string, symbol>());
type AccountDeletionAuthTransition = { key: string; id: symbol };

export function beginAccountDeletionAuthTransition(accountId?: string | null): AccountDeletionAuthTransition {
  const lease = { key: accountId ?? "legacy", id: Symbol() };
  accountDeletionAuthTransitions.setState((state) => new Map(state).set(lease.key, lease.id));
  return lease;
}
export function cancelAccountDeletionAuthTransition(lease?: AccountDeletionAuthTransition) {
  const key = lease?.key ?? "legacy";
  accountDeletionAuthTransitions.setState((state) => {
    if (lease && state.get(key) !== lease.id) return state;
    const next = new Map(state); next.delete(key); return next;
  });
}
export function hasAccountDeletionAuthTransition(accountId?: string | null) {
  return accountDeletionAuthTransitions.get().has(accountId ?? "legacy");
}

function humanizeValidationDetail(detail: string): string {
  const [rawField, ...rest] = detail.split(":");
  const rawMessage = rest.join(":").trim();
  if (!rawMessage) return detail;

  const field = rawField.trim();
  const label = field
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
  let message = rawMessage.replace(/^required$/i, "is required");

  const normalizedMessage = message.toLowerCase().replace(/[_-]+/g, " ");
  const normalizedField = field.toLowerCase().replace(/[_-]+/g, " ");
  if (normalizedField && normalizedMessage.startsWith(`${normalizedField} `)) {
    message = message.slice(field.length).trimStart();
  }

  return label ? `${label} ${message}` : message;
}

function getReadableErrorMessage(error: string | undefined, details: string[] | undefined) {
  if (error === "validation error" && details?.length) {
    return humanizeValidationDetail(details[0]);
  }
  return error;
}

/**
 * Leave the authenticated app with a full document navigation.
 *
 * API helpers do not have access to the Next router, and a 401 must discard
 * all in-memory authenticated state rather than preserve the current React
 * tree. Use an explicit same-origin absolute URL so this intentional hard
 * navigation is not mistaken for an internal client-side route transition.
 */
export function redirectToSignIn(accountId?: string | null) {
  if (typeof window === "undefined") return;
  if (hasAccountDeletionAuthTransition(accountId)) return;
  window.location.assign(new URL("/sign-in", window.location.origin));
}

export type ApiRequestOptions = RequestInit & { assertActive?: () => void; onUnauthorized?: () => Promise<boolean>; authenticationAccount?: string };

export async function apiFetchResponse(path: string, options?: ApiRequestOptions): Promise<Response> {
  const { assertActive, onUnauthorized, authenticationAccount, ...request } = options ?? {};
  const assertEligible = () => {
    assertActive?.();
    if (request.signal?.aborted) throw new DOMException("Cancelled request", "AbortError");
  };
  assertEligible();
  if (MOCK_NETWORK_ENABLED) {
    if (!mockNetworkLogged) {
      console.info(`[Mock Network] Enabled — ${MOCK_NETWORK_DELAY_MS}ms delay on all API requests`);
      mockNetworkLogged = true;
    }
    await new Promise((r) => setTimeout(r, MOCK_NETWORK_DELAY_MS));
  }

  let res: Response;
  try {
    assertEligible();
    const headers = new Headers(request.headers);
    if (!headers.has("Content-Type") && !(typeof FormData !== "undefined" && request.body instanceof FormData)) headers.set("Content-Type", "application/json");
    res = await fetch(API_BASE + path, {
      ...request,
      credentials: "include",
      headers,
    });
  } catch (err) {
    assertEligible();
    if (err instanceof TypeError) {
      throw new ApiError("Unable to connect — check your network", 0);
    }
    throw err;
  }

  assertEligible();

  if (res.status === 401) {
    if (hasAccountDeletionAuthTransition(authenticationAccount)) throw new ApiError("Unauthorized", 401);
    if (onUnauthorized && !await onUnauthorized()) throw new DOMException("Retired authentication transition", "AbortError");
    redirectToSignIn(authenticationAccount);
    throw new UnauthorizedError();
  }

  if (!res.ok) {
    let serverError: string | undefined;
    let details: string[] | undefined;
    try {
      const body = (await res.json()) as { error?: string; details?: string[] };
      serverError = body.error;
      details = body.details;
    } catch {
      // non-JSON body (HTML from proxy, empty body, etc.)
    }

    assertEligible();

    if (res.status === 429) {
      throw new ApiError("Please wait a moment before trying again", 429);
    }

    if (res.status >= 500) {
      throw new ApiError(
        getReadableErrorMessage(serverError, details) ||
        "Something went wrong — please try again",
        res.status,
        details,
      );
    }

    throw new ApiError(
      getReadableErrorMessage(serverError, details) || "Something went wrong",
      res.status,
      details,
    );
  }

  return res;
}

export async function apiFetch<T>(path: string, options?: ApiRequestOptions): Promise<T> {
  const res = await apiFetchResponse(path, options);
  if (res.status === 204) return undefined as T;
  const data = await res.json() as T;
  options?.assertActive?.();
  if (options?.signal?.aborted) throw new DOMException("Cancelled request", "AbortError");
  return data;
}

export function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

// Lazy import — this module is imported by every `src/lib/api/*` consumer
// (including non-community, server-agnostic callers under `src/lib/api.ts`'s
// re-exports), many of which run in plain-node test environments with no
// `document`. `sonner` injects a `<style>` tag at import time, which throws
// outside a real DOM. A top-level `import { toast } from "sonner"` would
// break every one of those call sites just for this optional feature.
export function toastApiError(err: unknown, fallback: string, assertActive?: () => void): void {
  if (isAbortError(err)) return;
  void import("sonner")
    .then(({ toast }) => {
      assertActive?.();
      toast.error(getErrorMessage(err, fallback));
    })
    .catch(() => {});
}

export async function readUploadError(res: Response, fallback: string): Promise<ApiError> {
  let serverError: string | undefined;
  try {
    const body = (await res.json()) as { error?: string };
    serverError = body.error;
  } catch {
    // non-JSON body
  }
  return new ApiError(serverError || fallback, res.status);
}

export function wsQuery(workspaceId: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ workspace_id: workspaceId, ...extra });
  return `?${params.toString()}`;
}
