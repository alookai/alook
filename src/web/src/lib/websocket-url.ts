export type WebSocketTarget = "user" | "community-daemon"

export function websocketUrl(
  target: WebSocketTarget,
  options: { local: true; port: number } | { local: false; origin: string },
): string {
  const base = options.local
    ? `ws://localhost:${options.port}`
    : options.origin.replace("http", "ws")
  return `${base}/api/ws/${target}`
}
