const backendLabels = new Map([
  ["claude", "Claude"],
  ["codex", "Codex (automatic)"],
  ["codex-app", "Codex App"],
  ["codex-cli", "Codex CLI"],
  ["cursor", "Cursor"],
  ["cursor-sdk", "Cursor SDK"],
  ["grok", "Grok"],
  ["opencode", "OpenCode"],
  ["pi", "Pi"],
  ["pi-durable", "Pi Durable"],
  ["antigravity", "Antigravity"],
  ["agy", "Antigravity CLI"],
  ["qoder", "Qoder"],
  ["copilot", "GitHub Copilot"],
])

export function runtimeLabel(runtime: string): string {
  return backendLabels.get(runtime) ?? runtime
}

export function visibleRuntimes<T extends { id: string }>(runtimes: readonly T[], selectedRuntime?: string): T[] {
  return runtimes.filter(({ id }) => id !== "codex" || selectedRuntime === "codex")
}
