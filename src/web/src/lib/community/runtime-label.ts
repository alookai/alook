const backendLabels = new Map([
  ["codex", "Codex (automatic)"],
  ["codex-app", "Codex"],
  ["codex-cli", "Codex CLI"],
  ["agy", "antigravity cli"],
  ["qoder", "Qoder"],
  ["copilot", "GitHub Copilot"],
  ["cursor-sdk", "Cursor SDK"],
  ["pi-durable", "Pi Durable"],
])

export function runtimeLabel(runtime: string): string {
  return backendLabels.get(runtime) ?? runtime
}

export function visibleRuntimes<T extends { id: string }>(runtimes: readonly T[], selectedRuntime?: string): T[] {
  const split = runtimes.some(({ id }) => id === "codex-app" || id === "codex-cli")
  return runtimes.filter(({ id }) => id !== "codex" || !split || selectedRuntime === "codex")
}
