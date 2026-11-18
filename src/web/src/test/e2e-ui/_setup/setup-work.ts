type SetupPhase =
  | "prepare-services"
  | "start-services"
  | "reset-db"
  | "service-health"
  | "services-ready"
  | "warm-routes"
  | "launch-browser"
  | "prepare-user"
  | "close-browser"
  | "write-manifest"
  | "setup-cleanup"
  | "global-teardown"

function startPhase(phase: SetupPhase, slot?: number) {
  const start = performance.now()
  const emit = (event: "start" | "end", outcome?: "passed" | "failed") => {
    try {
      console.log(JSON.stringify({ type: "alook:e2e:setup-phase", phase, ...(slot === undefined ? {} : { slot }),
        event, at: new Date().toISOString(), ...(outcome ? { outcome, durationMs: performance.now() - start } : {}) }))
    } catch {}
  }
  emit("start")
  return (outcome: "passed" | "failed") => { emit("end", outcome) }
}

export function measureSetupSync<T>(phase: SetupPhase, action: () => T, slot?: number): T {
  const finish = startPhase(phase, slot)
  try {
    const value = action()
    finish("passed")
    return value
  } catch (error) {
    finish("failed")
    throw error
  }
}

export async function measureSetupAsync<T>(phase: SetupPhase, action: () => Promise<T>, slot?: number): Promise<T> {
  const finish = startPhase(phase, slot)
  try {
    const value = await action()
    finish("passed")
    return value
  } catch (error) {
    finish("failed")
    throw error
  }
}

export async function prepareSetupUsers<T>(users: readonly T[], prepare: (user: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  const failures: Array<{ index: number; error: unknown }> = []
  await Promise.all(Array.from({ length: Math.min(2, users.length) }, async () => {
    while (!failed) {
      const index = next++
      if (index >= users.length) return
      try { await prepare(users[index]!, index) }
      catch (error) { failed = true; failures.push({ index, error }) }
    }
  }))
  const errors = failures.sort((left, right) => left.index - right.index).map(failure => failure.error)
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, "Setup user preparation failed")
}
