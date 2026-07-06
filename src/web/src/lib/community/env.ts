function required(name: string, devFallback: string): string {
  const value = process.env[name]
  if (value && value.length > 0) return value
  if (process.env.NODE_ENV === "production") {
    throw new Error(`Missing required env var ${name}`)
  }
  return devFallback
}

export const COMMUNITY_SERVER_URL = required(
  "NEXT_PUBLIC_COMMUNITY_SERVER_URL",
  "http://localhost:3000",
)
export const COMMUNITY_DAEMON_WS_URL = required(
  "NEXT_PUBLIC_COMMUNITY_DAEMON_WS_URL",
  "ws://localhost:8789",
)
