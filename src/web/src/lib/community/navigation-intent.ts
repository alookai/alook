export type NavigationIntentGate = { revision: number }

export function createNavigationIntentGate(): NavigationIntentGate {
  return { revision: 0 }
}

export function supersedeNavigationIntent(gate: NavigationIntentGate): void {
  gate.revision += 1
}

export async function commitLatestNavigationIntent<T>(
  gate: NavigationIntentGate,
  resolve: () => Promise<T>,
  commit: (value: T) => void,
): Promise<boolean> {
  const revision = ++gate.revision
  const value = await resolve()
  if (revision !== gate.revision) return false
  commit(value)
  return true
}
