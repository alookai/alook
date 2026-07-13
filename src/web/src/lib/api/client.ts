import { ApiError } from "@/lib/errors";

const API_BASE = "";

const MOCK_NETWORK_ENABLED = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_MOCK_NETWORK === "true";
const MOCK_NETWORK_DELAY_MS = parseInt(process.env.NEXT_PUBLIC_MOCK_NETWORK_DELAY_MS || "300", 10) || 300;
let mockNetworkLogged = false;

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

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  if (MOCK_NETWORK_ENABLED) {
    if (!mockNetworkLogged) {
      console.info(`[Mock Network] Enabled — ${MOCK_NETWORK_DELAY_MS}ms delay on all API requests`);
      mockNetworkLogged = true;
    }
    await new Promise((r) => setTimeout(r, MOCK_NETWORK_DELAY_MS));
  }

  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ApiError("Unable to connect — check your network", 0);
    }
    throw err;
  }

  if (res.status === 401) {
    if (typeof window !== "undefined") {
      window.location.href = "/sign-in";
    }
    throw new ApiError("Unauthorized", 401);
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

  if (res.status === 204) return undefined as T;
  return res.json();
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
export function toastApiError(err: unknown, fallback: string): void {
  void import("sonner")
    .then(({ toast }) => toast.error(getErrorMessage(err, fallback)))
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
