const FIRST_SIGNUP_GUIDE_KEY = "alook:first-signup-guide:v1"
const FIRST_SIGNUP_GUIDE_TTL_MS = 10 * 60 * 1000

type GuideStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export type FirstSignupGuideHandoff = {
  version: 1
  seed: string
  createdAt: number
}

function browserStorage(): GuideStorage | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function parseHandoff(value: string | null, now: number): FirstSignupGuideHandoff | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<FirstSignupGuideHandoff>
    if (
      parsed.version !== 1 ||
      typeof parsed.seed !== "string" ||
      parsed.seed.length === 0 ||
      typeof parsed.createdAt !== "number" ||
      parsed.createdAt > now ||
      now - parsed.createdAt > FIRST_SIGNUP_GUIDE_TTL_MS
    ) {
      return null
    }
    return parsed as FirstSignupGuideHandoff
  } catch {
    return null
  }
}

export function writeFirstSignupGuideHandoff(
  storage: GuideStorage | null = browserStorage(),
  now = Date.now(),
  randomId = globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random()}`,
): FirstSignupGuideHandoff | null {
  if (!storage) return null
  const handoff: FirstSignupGuideHandoff = {
    version: 1,
    seed: `alook-guide-${randomId}`,
    createdAt: now,
  }
  try {
    storage.setItem(FIRST_SIGNUP_GUIDE_KEY, JSON.stringify(handoff))
    return handoff
  } catch {
    return null
  }
}

export function readFirstSignupGuideHandoff(
  storage: GuideStorage | null = browserStorage(),
  now = Date.now(),
): FirstSignupGuideHandoff | null {
  if (!storage) return null
  try {
    const handoff = parseHandoff(storage.getItem(FIRST_SIGNUP_GUIDE_KEY), now)
    if (!handoff) storage.removeItem(FIRST_SIGNUP_GUIDE_KEY)
    return handoff
  } catch {
    return null
  }
}

export function consumeFirstSignupGuideHandoff(
  seed: string,
  storage: GuideStorage | null = browserStorage(),
): void {
  if (!storage) return
  try {
    const stored = JSON.parse(storage.getItem(FIRST_SIGNUP_GUIDE_KEY) ?? "null") as Partial<FirstSignupGuideHandoff> | null
    if (stored?.version === 1 && stored.seed === seed) {
      storage.removeItem(FIRST_SIGNUP_GUIDE_KEY)
    }
  } catch {
    storage.removeItem(FIRST_SIGNUP_GUIDE_KEY)
  }
}
