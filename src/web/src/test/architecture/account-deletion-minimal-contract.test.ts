import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../../..")
const source = (path: string) => readFileSync(resolve(root, path), "utf8")

describe("minimal account deletion architecture", () => {
  it("adds exactly two cookie-authenticated user APIs", () => {
    const apiRoot = resolve(root, "src/app/api/community/users/me/account-deletion")
    expect(readdirSync(apiRoot, { recursive: true })
      .filter((entry) => String(entry).endsWith("route.ts"))
      .sort()).toEqual(["code/route.ts", "route.ts"])
    for (const route of [
      "src/app/api/community/users/me/account-deletion/code/route.ts",
      "src/app/api/community/users/me/account-deletion/route.ts",
    ]) {
      expect(source(route)).toContain("withCookieHumanAuth")
    }
  })

  it("uses existing persistence and bindings without a migration or workflow", () => {
    const migrations = readdirSync(resolve(root, "migrations"))
    expect(migrations.some((file) => file.includes("account_deletion"))).toBe(false)
    const files = [
      "src/lib/account-deletion/challenge.ts",
      "src/lib/account-deletion/storage.ts",
      "src/lib/account-deletion/execution.ts",
      "../shared/src/db/queries/account-deletion.ts",
    ].map(source).join("\n")
    expect(files).toContain("verification")
    expect(files).toContain("EMAIL_BUCKET")
    expect(files).toContain("COMMUNITY_MEDIA")
    expect(files).toContain("BUG_REPORTS")
    expect(files).not.toContain("WorkflowEntrypoint")
    expect(files).not.toContain("scheduled(")
  })

  it("requires an explicit final click after all six OTP digits", () => {
    const flow = source("src/components/community/settings/account-deletion-flow.tsx")
    expect(flow).toContain('onClick={deleteAccount}')
    expect(flow).not.toContain("onComplete=")
    expect(flow).toContain('variant="destructive"')
  })

  it("keeps the completion state in the sign-in URL across reloads", () => {
    const signIn = source("src/app/(auth)/sign-in/sign-in-client.tsx")
    expect(signIn).toContain('searchParams.get("account_deleted") === "1"')
    expect(signIn).toContain("Account deleted")
    expect(signIn).toContain("Your account and its data were removed.")
  })
})
