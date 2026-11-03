const backendLabels = new Map([
  ["agy", "antigravity cli"],
  ["qoder", "Qoder"],
  ["copilot", "GitHub Copilot"],
  ["cursor-sdk", "Cursor SDK"],
  ["pi-durable", "Pi Durable"],
])

export function runtimeLabel(runtime: string): string {
  return backendLabels.get(runtime) ?? runtime
}
