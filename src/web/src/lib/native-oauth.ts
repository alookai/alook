import {
  nativeOauthAttemptIdSchema,
  nativeOauthExchangeSchema,
  nativeOauthProofSchema,
  nativeOauthRegistrationSchema,
  type NativeOauthFailureCode,
  type NativeOauthPlatform,
  type NativeOauthProvider,
} from "@alook/shared";
export {
  nativeOauthExchangeSchema,
  nativeOauthProofSchema,
  nativeOauthRegistrationSchema,
};
export type { NativeOauthPlatform, NativeOauthProvider };

const MAX_JSON_BODY_BYTES = 4096;
const NATIVE_OAUTH_RETURN_ORIGIN = "https://auth.alook.ai";
const NATIVE_OAUTH_RETURN_PATH = "/auth/native/return";
export const nativeOauthSecurityHeaders = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

function mergeSecurityHeaders(headers?: HeadersInit): Headers {
  const merged = new Headers(headers);
  for (const [name, value] of Object.entries(nativeOauthSecurityHeaders)) {
    merged.set(name, value);
  }
  return merged;
}

export function nativeOauthJson(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return Response.json(body, {
    ...init,
    headers: mergeSecurityHeaders(init.headers),
  });
}

export function nativeOauthHtml(
  body: string,
  init: ResponseInit = {},
): Response {
  const headers = mergeSecurityHeaders(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

const NATIVE_OAUTH_ERROR_DOCUMENT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign-in unavailable · Alook</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f6f7f9; color: #17191d; }
    main { width: min(100%, 440px); }
    .card { border: 1px solid #e2e5ea; border-radius: 18px; padding: 28px; background: #fff; box-shadow: 0 14px 40px rgb(20 24 32 / 9%); }
    .brand { display: flex; align-items: center; gap: 10px; margin: 0 0 28px; color: #31343a; font-size: 15px; font-weight: 650; letter-spacing: .01em; }
    .mark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: #17191d; color: #fff; font-size: 15px; }
    .status { display: inline-block; margin-bottom: 12px; color: #666b75; font-size: 13px; font-weight: 600; }
    h1 { margin: 0; font-size: clamp(24px, 6vw, 31px); line-height: 1.2; letter-spacing: -.025em; }
    p { margin: 14px 0 0; color: #5f646d; font-size: 16px; line-height: 1.65; }
    @media (prefers-color-scheme: dark) {
      body { background: #111317; color: #f5f6f8; }
      .card { border-color: #30343b; background: #1b1e23; box-shadow: 0 14px 40px rgb(0 0 0 / 28%); }
      .brand { color: #e8eaed; }
      .mark { background: #f5f6f8; color: #17191d; }
      .status, p { color: #aeb3bd; }
    }
  </style>
</head>
<body>
  <main aria-labelledby="native-oauth-error-title">
    <section class="card" role="alert">
      <div class="brand"><span class="mark" aria-hidden="true">A</span><span>Alook</span></div>
      <span class="status">Authentication</span>
      <h1 id="native-oauth-error-title">Sign-in unavailable</h1>
      <p>Close this page and return to Alook to try again.</p>
    </section>
  </main>
</body>
</html>`;

export function nativeOauthErrorPage(status: number): Response {
  return nativeOauthHtml(NATIVE_OAUTH_ERROR_DOCUMENT, {
    status,
    headers: {
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

export function nativeOauthRedirect(
  location: string,
  sourceHeaders?: Headers,
): Response {
  const headers = mergeSecurityHeaders();
  headers.set("Location", location);
  if (sourceHeaders) copySetCookieHeaders(sourceHeaders, headers);
  return new Response(null, { status: 302, headers });
}

export function copySetCookieHeaders(source: Headers, target: Headers): void {
  for (const cookie of source.getSetCookie()) target.append("Set-Cookie", cookie);
}

async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return body + decoder.decode();
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    body += decoder.decode(value, { stream: true });
  }
}

type ParsedJson<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

type StrictSchema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false };
};

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]";
}

export function isNativeOauthRequestTarget(
  request: Request,
  expectedBaseUrl: string,
): boolean {
  const expectedUrl = new URL(expectedBaseUrl);
  const requestUrl = new URL(request.url);
  if (requestUrl.origin === expectedUrl.origin) return true;
  return isLoopbackHostname(requestUrl.hostname)
    && isLoopbackHostname(expectedUrl.hostname)
    && request.headers.get("Host") === expectedUrl.host;
}

export async function parseNativeOauthJson<T>(
  request: Request,
  expectedBaseUrl: string,
  schema: StrictSchema<T>,
): Promise<ParsedJson<T>> {
  const expectedUrl = new URL(expectedBaseUrl);
  const expectedOrigin = expectedUrl.origin;
  if (
    !isNativeOauthRequestTarget(request, expectedBaseUrl) ||
    request.headers.get("Origin") !== expectedOrigin
  ) {
    return {
      ok: false,
      response: nativeOauthJson({ error: "invalid_request" }, { status: 403 }),
    };
  }

  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return {
      ok: false,
      response: nativeOauthJson({ error: "invalid_request" }, { status: 415 }),
    };
  }

  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    return {
      ok: false,
      response: nativeOauthJson({ error: "invalid_request" }, { status: 413 }),
    };
  }

  const text = await readBoundedText(request, MAX_JSON_BODY_BYTES);
  if (text === null) {
    return {
      ok: false,
      response: nativeOauthJson({ error: "invalid_request" }, { status: 413 }),
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: nativeOauthJson({ error: "invalid_request" }, { status: 400 }),
    };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      response: nativeOauthJson({ error: "invalid_request" }, { status: 400 }),
    };
  }
  return { ok: true, data: parsed.data };
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(verifier);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function nativeOauthStartUrl(baseUrl: string, attemptId: string): string {
  const url = new URL("/auth/native/start", baseUrl);
  url.searchParams.set("attempt", attemptId);
  return url.toString();
}

export function nativeOauthCallbackUrls(baseUrl: string, attemptId: string) {
  const create = (kind: "signin" | "signup" | "error") => {
    const url = new URL("/auth/native/callback", baseUrl);
    url.searchParams.set("attempt", attemptId);
    url.searchParams.set("kind", kind);
    return url.toString();
  };
  return {
    callbackURL: create("signin"),
    newUserCallbackURL: create("signup"),
    errorCallbackURL: create("error"),
  } as const;
}

function isMobilePlatform(platform: NativeOauthPlatform): boolean {
  return platform === "ios" || platform === "android";
}

export function nativeOauthReturnUrl(
  platform: NativeOauthPlatform,
  attemptId: string,
  result: { code: string } | { status: NativeOauthFailureCode },
): string {
  const url = isMobilePlatform(platform)
    ? new URL(NATIVE_OAUTH_RETURN_PATH, NATIVE_OAUTH_RETURN_ORIGIN)
    : new URL("ai.alook.desktop://auth/native/return");
  url.searchParams.set("attempt", attemptId);
  if ("code" in result) url.searchParams.set("code", result.code);
  else url.searchParams.set("status", result.status);
  return url.toString();
}

export function sanitizeOauthFailure(
  error: string | null,
): "access_denied" | "provider_error" | "oauth_callback_failed" {
  if (error === "access_denied") return "access_denied";
  if (error === "no_code" || error === "invalid_code" || error === "oauth_provider_not_found") {
    return "provider_error";
  }
  return "oauth_callback_failed";
}

export function expireBrowserAnalyticsCookies(headers: Headers, secure: boolean): void {
  const suffix = `Max-Age=0; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
  headers.append("Set-Cookie", `is_new_signup=; ${suffix}`);
  headers.append("Set-Cookie", `is_sign_in=; ${suffix}`);
}

export function setWebViewAnalyticsCookie(
  headers: Headers,
  authKind: "signin" | "signup",
  provider: NativeOauthProvider,
  secure: boolean,
): void {
  const name = authKind === "signup" ? "is_new_signup" : "is_sign_in";
  const suffix = `Max-Age=60; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
  headers.append("Set-Cookie", `${name}=${provider}; ${suffix}`);
}

export function isNativeOauthAttemptId(value: string | null): value is string {
  return value !== null && nativeOauthAttemptIdSchema.safeParse(value).success;
}
