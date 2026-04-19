const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 300

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetch(url, init)
    } catch (e) {
      const isRetryable =
        e instanceof TypeError &&
        (e.message.includes("fetch failed") || e.message.includes("socket"))
      if (attempt < MAX_RETRIES && isRetryable) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt))
        continue
      }
      throw e
    }
  }
  throw new Error("unreachable")
}

/**
 * Sign up a new user via Better Auth.
 * Returns the response (check status to see if successful).
 */
export async function signUp(email: string, password: string, name: string) {
  return fetch(`${APP_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_URL },
    body: JSON.stringify({ email, password, name }),
    redirect: "manual",
  })
}

/**
 * Sign in and return the raw set-cookie header value.
 */
export async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${APP_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_URL },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  })
  const setCookie = res.headers.get("set-cookie") ?? ""
  if (!setCookie) {
    throw new Error(`sign-in failed (${res.status}): no set-cookie header`)
  }
  return setCookie.split(";")[0]
}

/**
 * Make an authenticated request with a session cookie.
 */
export async function sessionRequest(
  path: string,
  cookie: string,
  opts: RequestInit = {},
): Promise<Response> {
  return fetchWithRetry(`${APP_URL}${path}`, {
    ...opts,
    headers: {
      ...(opts.headers ?? {}),
      Cookie: cookie,
    },
  })
}

/**
 * Make an authenticated request with a Bearer token.
 */
export async function tokenRequest(
  path: string,
  token: string,
  opts: RequestInit = {},
): Promise<Response> {
  return fetchWithRetry(`${APP_URL}${path}`, {
    ...opts,
    headers: {
      ...(opts.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  })
}
