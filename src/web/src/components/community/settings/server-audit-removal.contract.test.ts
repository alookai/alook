import auditMigration from "../../../../migrations/0084_drop_community_audit_log.sql?raw"
import communitySchema from "../../../../../shared/src/db/community-schema.ts?raw"
import contractText0 from "../../../app/api/community/bots/[id]/audit-log/route.ts?raw"
import contractText1 from "../channels/channel-sidebar.tsx?raw"
import contractText2 from "./server-settings.tsx?raw"
import contractText3 from "./settings-types.ts?raw"
import contractText4 from "../../../hooks/community/use-server-panels.ts?raw"
import contractText5 from "../../../lib/query-keys.ts?raw"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const componentDirectory = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(componentDirectory, "../../../..")
const repositoryRoot = resolve(webRoot, "../..")

const contractSources: Record<string, string> = {
  "src/app/api/community/bots/[id]/audit-log/route.ts": contractText0,
  "src/components/community/channels/channel-sidebar.tsx": contractText1,
  "src/components/community/settings/server-settings.tsx": contractText2,
  "src/components/community/settings/settings-types.ts": contractText3,
  "src/hooks/community/use-server-panels.ts": contractText4,
  "src/lib/query-keys.ts": contractText5,
  "migrations/0084_drop_community_audit_log.sql": auditMigration,
}
const readWeb = (path: string) => {
  if (!(path in contractSources)) throw new Error("unregistered contract source: " + path)
  return contractSources[path]
}

describe("server audit removal contract", () => {
  it("removes the server settings surface and client query", () => {
    expect(readWeb("src/components/community/settings/server-settings.tsx")).not.toContain("Audit Log")
    expect(readWeb("src/components/community/channels/channel-sidebar.tsx")).not.toContain("Audit Log")
    expect(readWeb("src/components/community/settings/settings-types.ts")).not.toContain('| "audit"')
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
    expect(communitySchema).toContain("communityBotActivityEvent")
  })
})
