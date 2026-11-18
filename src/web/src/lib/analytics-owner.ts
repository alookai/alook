type AnalyticsLifecycle = { get: () => { active: boolean; generation: number } }

export function captureAnalyticsOwner(lifecycle: AnalyticsLifecycle) {
  const generation = lifecycle.get().generation
  return () => {
    const current = lifecycle.get()
    if (!current.active || current.generation !== generation) throw new DOMException("Retired analytics owner", "AbortError")
  }
}
