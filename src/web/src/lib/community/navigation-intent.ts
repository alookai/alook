export type NavigationIntentGate = { revision: number }

export function createNavigationIntentGate(): NavigationIntentGate {
  return { revision: 0 }
}

export function supersedeNavigationIntent(gate: NavigationIntentGate): number {
  gate.revision += 1
  return gate.revision
}

export function isLatestNavigationIntent(
  gate: NavigationIntentGate,
  revision: number,
): boolean {
  return gate.revision === revision
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
