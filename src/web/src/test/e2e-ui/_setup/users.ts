export type UserKey = "alice" | "bob" | "carol" | "dave" | "logout"

export const USER_KEYS: UserKey[] = ["alice", "bob", "carol", "dave", "logout"]

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
