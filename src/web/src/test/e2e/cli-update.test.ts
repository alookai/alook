import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { seedTestData, cleanupTestData, type TestSeed } from "../helpers/seed";
import { tokenRequest } from "../helpers/auth";
import { sql, sqlQuery } from "../helpers/db";

let seed: TestSeed;

beforeAll(() => {
  seed = seedTestData();
});
afterAll(() => cleanupTestData(seed));

describe("CLI auto-update e2e", () => {
  const daemonId = `daemon_upd_${randomUUID().slice(0, 8)}`;
  const daemonId2 = `daemon_upd2_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    // Register two daemons to avoid 30s misc-throttle conflicts between tests
    const res = await tokenRequest("/api/daemon/register", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: seed.workspaceId,
        daemon_id: daemonId,
        device_name: "update-test-machine",
        cli_version: "0.0.1",
        runtimes: [
          { provider: "claude", runtime_mode: "local", version: "4.0" },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const res2 = await tokenRequest("/api/daemon/register", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: seed.workspaceId,
        daemon_id: daemonId2,
        device_name: "update-test-machine-2",
        cli_version: "0.0.1",
        runtimes: [
          { provider: "claude", runtime_mode: "local", version: "4.0" },
        ],
      }),
    });
    expect(res2.status).toBe(200);
  });

  it("POST /api/runtimes/:id/update sets pendingUpdateVersion on machine", async () => {
    sql(
      `UPDATE machine SET pending_update_version = '1.0.0' WHERE daemon_id = '${daemonId}' AND workspace_id = '${seed.workspaceId}'`,
    );

    const rows = sqlQuery<{ pending_update_version: string | null }>(
      `SELECT pending_update_version FROM machine WHERE daemon_id = '${daemonId}' AND workspace_id = '${seed.workspaceId}'`,
    );
    expect(rows[0]?.pending_update_version).toBe("1.0.0");
  });

  it("poll returns pending_update when version is older", async () => {
    const res = await tokenRequest("/api/daemon/tasks/poll", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        daemon_id: daemonId,
        cli_version: "0.0.1",
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { tasks: unknown[]; pending_update?: { version: string } };
    expect(data.pending_update).toEqual({ version: "1.0.0" });
  });

  it("poll auto-clears pendingUpdateVersion when cli_version matches", async () => {
    // Use a separate daemon to avoid 30s misc-throttle from previous poll
    sql(
      `UPDATE machine SET pending_update_version = '1.0.0' WHERE daemon_id = '${daemonId2}' AND workspace_id = '${seed.workspaceId}'`,
    );

    const res = await tokenRequest("/api/daemon/tasks/poll", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        daemon_id: daemonId2,
        cli_version: "1.0.0",
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { tasks: unknown[]; pending_update?: unknown };
    expect(data.pending_update).toBeUndefined();

    const rows = sqlQuery<{ pending_update_version: string | null }>(
      `SELECT pending_update_version FROM machine WHERE daemon_id = '${daemonId2}' AND workspace_id = '${seed.workspaceId}'`,
    );
    expect(rows[0]?.pending_update_version).toBeNull();
  });

  afterAll(() => {
    try {
      sql(`DELETE FROM agent_runtime WHERE daemon_id = '${daemonId}'`);
      sql(`DELETE FROM machine WHERE daemon_id = '${daemonId}'`);
      sql(`DELETE FROM agent_runtime WHERE daemon_id = '${daemonId2}'`);
      sql(`DELETE FROM machine WHERE daemon_id = '${daemonId2}'`);
    } catch { /* ignore */ }
  });
});
