// The community journeys use up to three concurrent users. Each gets a fresh
// account seeded by the dev sign-in flow (email-only → DEV_PASSWORD auto
// signup). Emails are unique per run via a stamp injected at setup time so a
// re-run against a non-reset DB doesn't collide.
export type UserKey = "alice" | "bob" | "carol"

export const USER_KEYS: UserKey[] = ["alice", "bob", "carol"]

export function emailFor(key: UserKey, stamp: string): string {
  return `e2e-${key}-${stamp}@alook.test`
}

export interface SeededUser {
  key: UserKey
  email: string
  name: string
  userId: string
  storageState: string
}

export interface RunManifest {
  stamp: string
  users: Record<UserKey, SeededUser>
}
