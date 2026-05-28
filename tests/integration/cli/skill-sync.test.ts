import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import {
  seedTestData,
  cleanupTestData,
  type TestSeed,
  sqlQuery,
} from "@alook/test-utils"
import { DaemonClient } from "../../../src/cli/daemon/client"

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
const client = new DaemonClient(APP_URL)

let seed: TestSeed
const daemonId = `daemon_skill_${randomUUID().slice(0, 8)}`

beforeAll(async () => {
  seed = seedTestData()

  await client.register(seed.machineToken, {
    workspace_id: seed.workspaceId,
    daemon_id: daemonId,
    device_name: "skill-test-machine",
    cli_version: "0.1.0-integ",
    runtimes: [{ provider: "claude", runtime_mode: "local", version: "4.0" }],
  })
})
afterAll(() => cleanupTestData(seed))

describe("skill sync", () => {
  const skills = [
    { name: "test-skill-alpha", description: "Alpha skill for testing" },
    { name: "test-skill-beta", description: "Beta skill for testing" },
  ]

  it("POST /api/daemon/skills/sync (global scope) stores skills in DB", async () => {
    await client.syncSkills(seed.machineToken, {
      scope: "global",
      daemon_id: daemonId,
      runtime: "claude",
      skills,
    })

    const rows = sqlQuery<{ name: string; description: string; runtime: string; daemon_id: string | null }>(
      `SELECT name, description, runtime, daemon_id FROM agent_skill WHERE workspace_id = '${seed.workspaceId}' AND runtime = 'claude' AND daemon_id = '${daemonId}' ORDER BY name`
    )
    expect(rows.length).toBeGreaterThanOrEqual(2)
    const alpha = rows.find(r => r.name === "test-skill-alpha")
    const beta = rows.find(r => r.name === "test-skill-beta")
    expect(alpha).toBeDefined()
    expect(alpha!.description).toBe("Alpha skill for testing")
    expect(beta).toBeDefined()
    expect(beta!.description).toBe("Beta skill for testing")
  })

  it("re-sync replaces old skills (stale removal)", async () => {
    await client.syncSkills(seed.machineToken, {
      scope: "global",
      daemon_id: daemonId,
      runtime: "claude",
      skills: [{ name: "test-skill-gamma", description: "Gamma replaces all" }],
    })

    const rows = sqlQuery<{ name: string }>(
      `SELECT name FROM agent_skill WHERE workspace_id = '${seed.workspaceId}' AND runtime = 'claude' AND daemon_id = '${daemonId}'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe("test-skill-gamma")
  })

  it("POST /api/daemon/skills/sync (agent scope) scopes to agent", async () => {
    await client.syncSkills(seed.machineToken, {
      scope: "agent",
      agent_id: seed.agentId,
      runtime: "claude",
      skills: [{ name: "agent-specific-skill", description: "Agent scoped" }],
    })

    const rows = sqlQuery<{ name: string; agent_id: string | null }>(
      `SELECT name, agent_id FROM agent_skill WHERE workspace_id = '${seed.workspaceId}' AND agent_id = '${seed.agentId}' AND runtime = 'claude'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe("agent-specific-skill")
    expect(rows[0].agent_id).toBe(seed.agentId)
  })

})
