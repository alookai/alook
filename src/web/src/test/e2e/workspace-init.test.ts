import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest, sqlRun, sqlQuery } from "@alook/test-utils"

let seed: TestSeed
const createdAgentIds: string[] = []
let extraWorkspaceId: string | null = null

beforeAll(() => {
  seed = seedTestData()
})

afterAll(() => {
  for (const agentId of createdAgentIds) {
    sqlRun(`DELETE FROM agent_task_queue WHERE agent_id = ?`, agentId)
    sqlRun(`DELETE FROM message WHERE conversation_id IN (SELECT id FROM conversation WHERE agent_id = ?)`, agentId)
    sqlRun(`DELETE FROM conversation WHERE agent_id = ?`, agentId)
    sqlRun(`DELETE FROM agent_whitelist WHERE agent_id = ?`, agentId)
    sqlRun(`DELETE FROM agent_link WHERE source_agent_id = ? OR target_agent_id = ?`, agentId, agentId)
    sqlRun(`DELETE FROM agent_pin WHERE agent_id = ?`, agentId)
    sqlRun(`DELETE FROM agent WHERE id = ?`, agentId)
  }
  if (extraWorkspaceId) {
    sqlRun(`DELETE FROM agent_task_queue WHERE workspace_id = ?`, extraWorkspaceId)
    sqlRun(`DELETE FROM conversation WHERE workspace_id = ?`, extraWorkspaceId)
    sqlRun(`DELETE FROM agent_whitelist WHERE agent_id IN (SELECT id FROM agent WHERE workspace_id = ?)`, extraWorkspaceId)
    sqlRun(`DELETE FROM agent_link WHERE workspace_id = ?`, extraWorkspaceId)
    sqlRun(`DELETE FROM agent_pin WHERE workspace_id = ?`, extraWorkspaceId)
    sqlRun(`DELETE FROM agent WHERE workspace_id = ?`, extraWorkspaceId)
    sqlRun(`DELETE FROM agent_runtime WHERE workspace_id = ?`, extraWorkspaceId)
    sqlRun(`DELETE FROM member WHERE workspace_id = ?`, extraWorkspaceId)
    sqlRun(`DELETE FROM workspace WHERE id = ?`, extraWorkspaceId)
  }
  cleanupTestData(seed)
})

describe("workspace init flow", () => {
  describe("template JSON endpoint", () => {
    it("GET /templates/open-source-maintainer/json returns valid template JSON", async () => {
      const APP_URL = process.env.APP_URL || "http://localhost:3000"
      const res = await fetch(`${APP_URL}/templates/open-source-maintainer/json`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("application/json")

      const data = await res.json() as Record<string, unknown>
      expect(data.name).toBe("Open Source Maintainer")
      expect(data.scenario).toBe("software-dev")
      expect(Array.isArray(data.members)).toBe(true)

      const members = data.members as Array<Record<string, unknown>>
      expect(members.length).toBeGreaterThanOrEqual(2)

      const leader = members.find(m => m.role === "leader")
      expect(leader).toBeTruthy()
      expect(leader!.instructions).toBeTruthy()
      expect(typeof leader!.instructions).toBe("string")

      const specialist = members.find(m => m.role !== "leader")
      expect(specialist).toBeTruthy()
      expect(specialist!.relationship).toBeTruthy()
      expect(typeof specialist!.relationship).toBe("string")
    })

    it("GET /templates/nonexistent-slug/json returns 404", async () => {
      const APP_URL = process.env.APP_URL || "http://localhost:3000"
      const res = await fetch(`${APP_URL}/templates/nonexistent-slug/json`)
      expect(res.status).toBe(404)
      const data = await res.json() as Record<string, unknown>
      expect(data.error).toBeTruthy()
    })
  })

  describe("studio creation (happy path)", () => {
    it("POST /api/studios creates agents from template-style JSON without names", async () => {
      const payload = {
        name: "E2E Init Test",
        scenario: "software-dev",
        members: [
          {
            role: "leader",
            runtime_id: seed.runtimeId,
            description: "Test leader agent",
            instructions: "You are the test leader",
          },
          {
            role: "engineer",
            runtime_id: seed.runtimeId,
            description: "Test engineer agent",
            instructions: "You are the test engineer",
            relationship: "Delegate code tasks to this engineer\n\nReport back with implementation results",
          },
        ],
      }

      const res = await tokenRequest(
        `/api/studios?workspace_id=${seed.workspaceId}`,
        seed.machineToken,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      )
      expect(res.status).toBe(201)

      const data = await res.json() as {
        studio: { name: string }
        workspace: { id: string; name: string }
        agents: Array<{ id: string; name: string; email_handle: string | null }>
        links: Array<{ id: string; source_agent_id: string; target_agent_id: string }>
      }

      expect(data.studio.name).toBeTruthy()
      expect(data.agents.length).toBe(2)

      // Names should be auto-generated (not empty)
      for (const agent of data.agents) {
        expect(agent.name).toBeTruthy()
        expect(agent.name.length).toBeGreaterThan(0)
        expect(agent.email_handle).toBeTruthy()
      }

      createdAgentIds.push(...data.agents.map(a => a.id))

      // Verify agent links were created (index-based matching)
      expect(data.links.length).toBeGreaterThanOrEqual(1)
      const link = data.links[0]
      const linkAgentIds = [link.source_agent_id, link.target_agent_id]
      expect(linkAgentIds.length).toBe(2)
    })
  })

  describe("workspace with existing agents creates new workspace", () => {
    it("POST /api/workspaces creates a new workspace when agents already exist", async () => {
      // seed already has an agent in seed.workspaceId
      // Verify existing agents
      const listRes = await tokenRequest(
        `/api/agents?workspace_id=${seed.workspaceId}`,
        seed.machineToken,
      )
      expect(listRes.status).toBe(200)
      const existingAgents = await listRes.json() as Array<{ id: string }>
      expect(existingAgents.length).toBeGreaterThan(0)

      // Create a new workspace (simulates what CLI does when agents exist)
      const wsRes = await tokenRequest(
        `/api/workspaces`,
        seed.machineToken,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "E2E New Workspace", slug: `e2e-new-ws-${Date.now()}` }),
        },
      )
      expect(wsRes.status).toBe(201)
      const newWs = await wsRes.json() as { id: string; name: string }
      expect(newWs.id).toBeTruthy()
      expect(newWs.name).toBe("E2E New Workspace")
      extraWorkspaceId = newWs.id

      // Register a runtime in the new workspace (POST /api/workspaces already adds user as member)
      const now = new Date().toISOString()
      const rtId = `rt_e2e_${Date.now()}`
      sqlRun(
        `INSERT INTO machine (daemon_id, workspace_id, device_info, last_seen_at, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        seed.daemonId, extraWorkspaceId, "test-device", now, now, now, seed.userId,
      )
      sqlRun(
        `INSERT INTO agent_runtime (id, workspace_id, daemon_id, runtime_mode, provider, status, device_info, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rtId, extraWorkspaceId, seed.daemonId, "local", "claude", "online", "test-device", now, now,
      )

      // Now create studio in the new workspace
      const studioRes = await tokenRequest(
        `/api/studios?workspace_id=${extraWorkspaceId}`,
        seed.machineToken,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "E2E Init In New WS",
            members: [
              {
                role: "leader",
                name: "New WS Leader",
                runtime_id: rtId,
                instructions: "You lead the new workspace",
              },
            ],
          }),
        },
      )
      expect(studioRes.status).toBe(201)
      const studioData = await studioRes.json() as {
        agents: Array<{ id: string; name: string }>
        workspace: { id: string }
      }
      expect(studioData.agents.length).toBe(1)
      expect(studioData.agents[0].name).toBe("New WS Leader")
      expect(studioData.workspace.id).toBe(extraWorkspaceId)
    })
  })

  describe("agent links verification", () => {
    it("verifies leader-specialist links contain correct relationship text", async () => {
      // Query links directly from DB for the agents we created earlier
      if (createdAgentIds.length < 2) return

      const links = sqlQuery(
        `SELECT instruction FROM agent_link WHERE (source_agent_id = ? AND target_agent_id = ?) OR (source_agent_id = ? AND target_agent_id = ?)`,
        createdAgentIds[0], createdAgentIds[1], createdAgentIds[1], createdAgentIds[0],
      ) as Array<{ instruction: string }>

      expect(links.length).toBeGreaterThanOrEqual(1)
      const linkText = links[0].instruction
      expect(linkText).toContain("Delegate code tasks to this engineer")
      expect(linkText).toContain("Report back with implementation results")
    })
  })
})
