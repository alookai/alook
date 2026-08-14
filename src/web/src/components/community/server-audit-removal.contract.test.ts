import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const componentDirectory = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(componentDirectory, "../../..")
const repositoryRoot = resolve(webRoot, "../..")

const readWeb = (path: string) => readFileSync(resolve(webRoot, path), "utf8")
const readRepository = (path: string) => readFileSync(resolve(repositoryRoot, path), "utf8")

describe("server audit removal contract", () => {
  it("removes the server settings surface and client query", () => {
    expect(readWeb("src/components/community/server-settings.tsx")).not.toContain("Audit Log")
    expect(readWeb("src/components/community/channels/channel-sidebar.tsx")).not.toContain("Audit Log")
    expect(readWeb("src/components/community/settings-types.ts")).not.toContain('| "audit"')
    expect(readWeb("src/hooks/community/use-server-panels.ts")).not.toContain("useAuditLog")
    expect(readWeb("src/lib/query-keys.ts")).not.toContain("auditLog:")
  })

  it("removes the server API/query and drops only its table", () => {
    expect(existsSync(resolve(webRoot, "src/app/api/community/servers/[id]/audit-log/route.ts"))).toBe(false)
    expect(existsSync(resolve(repositoryRoot, "src/shared/src/db/queries/community/audit-log.ts"))).toBe(false)

    const migration = readWeb("migrations/0084_drop_community_audit_log.sql")
    expect(migration).toContain("DROP TABLE IF EXISTS community_audit_log")
    expect(migration).not.toContain("community_bot_activity_event")
  })

  it("preserves the independent bot activity contract", () => {
    expect(existsSync(resolve(webRoot, "src/app/api/community/bots/[id]/audit-log/route.ts"))).toBe(true)
    expect(existsSync(resolve(repositoryRoot, "src/shared/src/db/queries/community/bot-audit-log.ts"))).toBe(true)
    expect(readRepository("src/shared/src/db/community-schema.ts")).toContain("communityBotActivityEvent")
  })
})
