import { COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONTRACT_VERSION, DEV_WEB_URL } from "@alook/shared"
import { fetchWithRetry } from "./fetch"

const APP_URL = process.env.APP_URL ?? DEV_WEB_URL

export async function signUp(email: string, password: string, name: string) {
  return fetch(`${APP_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_URL },
    body: JSON.stringify({ email, password, name }),
    redirect: "manual",
  })
}

export async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${APP_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_URL },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  })
  const headers = res.headers as Headers & { getSetCookie?: () => string[] }
  const setCookies = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : (headers.get("set-cookie")?.split(/,(?=[^;,]+=)/) ?? [])
  if (setCookies.length === 0) {
    throw new Error(`sign-in failed (${res.status}): no set-cookie header`)
  }
  const sessionCookie = setCookies
    .map((line) => line.split(";")[0].trim())
    .find((cookie) => /^(?:__Secure-)?better-auth\.session_token=/.test(cookie))
  if (!sessionCookie) {
    throw new Error(`sign-in failed (${res.status}): no session cookie`)
  }
  return sessionCookie
}

export async function sessionRequest(
  path: string,
  cookie: string,
  opts: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(opts.headers)
  headers.set("Cookie", cookie)
  if (path.startsWith("/api/community/") && !headers.has(COMMUNITY_CONTRACT_HEADER)) headers.set(COMMUNITY_CONTRACT_HEADER, String(COMMUNITY_CONTRACT_VERSION))
  return fetchWithRetry(`${APP_URL}${path}`, { ...opts, headers })
}

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
