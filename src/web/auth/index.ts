export const AUTH_WORKER_HOST = "auth.alook.ai";
export const AUTH_WORKER_RETURN_PATH = "/auth/native/return";
export const AUTH_WORKER_AASA_PATH = "/.well-known/apple-app-site-association";
export const AUTH_WORKER_ASSET_LINKS_PATH = "/.well-known/assetlinks.json";

export const APPLE_APP_SITE_ASSOCIATION = {
  applinks: {
    apps: [],
    details: [
      {
        appID: "5RF24VHDQB.ai.alook.ios",
        components: [
          {
            "/": AUTH_WORKER_RETURN_PATH,
            comment: "Native OAuth handoff return",
          },
        ],
      },
    ],
  },
} as const;

export const ANDROID_ASSET_LINKS = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "ai.alook.android",
      sha256_cert_fingerprints: [
        "9D:C6:ED:E9:4B:A6:63:EE:C9:EC:98:FF:7B:AF:D5:5E:24:8B:6C:4B:C2:15:7F:CF:04:2D:F5:9B:0E:41:08:06",
      ],
    },
  },
] as const;

const ATTEMPT_ID = /^[A-Za-z0-9_-]{22,64}$/;
const HANDOFF_CODE = /^[A-Za-z0-9_-]{32,128}$/;
const FAILURE_CODES = new Set([
  "access_denied",
  "provider_error",
  "oauth_callback_failed",
  "start_failed",
  "invalid_handoff",
]);
const RETURN_QUERY_KEYS = new Set(["attempt", "code", "status"]);
const RETURN_SCRIPT = 'document.querySelector("[data-open-alook]")?.addEventListener("click",()=>{window.location.assign("ai.alook://auth/native/return"+window.location.search)});';
const RETURN_SCRIPT_SHA256 = "5yRFm/Mu9yL952eR8mqLHHTJZnHDNb5SC5aES535aMk=";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

const RETURN_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  `script-src 'sha256-${RETURN_SCRIPT_SHA256}'`,
  "style-src 'unsafe-inline'",
].join("; ");

const PAGE_STYLE = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8f7f4; color: #171717; padding: 24px; }
  main { width: min(100%, 384px); text-align: center; }
  h1 { margin: 0 0 16px; font-size: 28px; line-height: 1.2; }
  p { margin: 0; color: #666; line-height: 1.5; }
  button { margin-top: 24px; min-height: 44px; border: 0; border-radius: 10px; padding: 0 20px; background: #171717; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  @media (prefers-color-scheme: dark) { body { background: #171717; color: #f8f7f4; } p { color: #aaa; } button { background: #f8f7f4; color: #171717; } }
`;

function returnPage(valid: boolean): string {
  const detail = valid
    ? "Continue in the Alook app to finish this sign-in."
    : "This sign-in link is invalid or has expired.";
  const control = valid
    ? `<button type="button" data-open-alook>Open Alook</button><script>${RETURN_SCRIPT}</script>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Return to Alook</title><style>${PAGE_STYLE}</style></head><body><main><h1>Return to Alook</h1><p>${detail}</p>${control}</main></body></html>`;
}

function response(
  request: Request,
  body: BodyInit | null,
  init: ResponseInit,
): Response {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(request.method === "HEAD" ? null : body, {
    ...init,
    headers,
  });
}

function notFound(request: Request): Response {
  return response(request, "Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function json(request: Request, value: unknown): Response {
  return response(request, JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function hasValidReturnQuery(url: URL): boolean {
  if (url.search.length > 512) return false;
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => !RETURN_QUERY_KEYS.has(key))) return false;

  const attempts = url.searchParams.getAll("attempt");
  const codes = url.searchParams.getAll("code");
  const statuses = url.searchParams.getAll("status");
  if (attempts.length !== 1 || !ATTEMPT_ID.test(attempts[0]!)) return false;

  const validCode = codes.length === 1
    && statuses.length === 0
    && HANDOFF_CODE.test(codes[0]!);
  const validStatus = statuses.length === 1
    && codes.length === 0
    && FAILURE_CODES.has(statuses[0]!);
  return validCode || validStatus;
}

function html(request: Request, valid: boolean): Response {
  return response(request, returnPage(valid), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": RETURN_CSP,
    },
  });
}

export function handleRequest(request: Request): Response {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:"
    || url.hostname !== AUTH_WORKER_HOST
    || url.port !== ""
    || (request.method !== "GET" && request.method !== "HEAD")
  ) {
    return notFound(request);
  }

  if (url.pathname === AUTH_WORKER_AASA_PATH && url.search === "") {
    return json(request, APPLE_APP_SITE_ASSOCIATION);
  }
  if (url.pathname === AUTH_WORKER_ASSET_LINKS_PATH && url.search === "") {
    return json(request, ANDROID_ASSET_LINKS);
  }
  if (url.pathname === AUTH_WORKER_RETURN_PATH) {
    return html(request, hasValidReturnQuery(url));
  }
  return notFound(request);
}

const authWorker = {
  fetch(request: Request): Response {
    return handleRequest(request);
  },
};

export default authWorker;
