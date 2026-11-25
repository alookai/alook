import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { makeRuntimeConfig, type CalendarEvent, type HostCommand } from "@alook/shared";
import { registerCalendarCommands } from "./calendar.js";
import { createProxyServerApi } from "./proxyServerApi.js";
import { resolveProxyCapability, resolveProxyAuditOperation } from "../credentials/route-policy.js";
import { WsControlChannel } from "../server/wsControlChannel.js";
import { AgentRouter } from "../manager/agentRouter.js";

const sampleEvent: CalendarEvent = {
  id: "cal_test_1",
  title: "Weekly retro",
  description: "Collect updates",
  createdBy: {
    id: "u_bot_internal_1",
    handle: "@Elwira#8700",
    name: "Elwira",
    avatarVersion: 2,
    isBot: true,
  },
  startAt: "2026-11-26T01:00:00.000Z",
  durationMinutes: 30,
  timeZone: "Asia/Shanghai",
  recurrence: { freq: "weekly", interval: 1, byWeekday: [1, 3, 5] },
  nextRunAt: "2026-11-27T01:00:00.000Z",
  sourceMessage: {
    id: "msg_internal_99",
    accessible: true,
    status: "accessible",
    ref: "/Alook#5620/gus-infra#1801",
    channelRef: "/Alook#5620/gus-infra",
    seq: 1801,
    preview: "Bind this thread",
  },
  lastExecution: {
    scheduledAt: "2026-11-26T01:00:00.000Z",
    status: "dispatched",
    lastError: null,
    ackedAt: null,
    updatedAt: "2026-11-26T01:00:01.000Z",
  },
  createdAt: "2026-11-25T04:00:00.000Z",
  updatedAt: "2026-11-25T04:00:00.000Z",
};

describe("calendar CLI & proxy route policy", () => {
  it("whitelists calendar routes with read/send capabilities and audit ops", () => {
    expect(resolveProxyCapability("GET", "/api/community/calendar/events")).toBe("read");
    expect(resolveProxyCapability("POST", "/api/community/calendar/events")).toBe("send");
    expect(resolveProxyCapability("PATCH", "/api/community/calendar/events/cal_1")).toBe("send");
    expect(resolveProxyCapability("DELETE", "/api/community/calendar/events/cal_1")).toBe("send");
    expect(resolveProxyAuditOperation("/api/community/calendar/events", "GET")).toBe("calendarList");
    expect(resolveProxyAuditOperation("/api/community/calendar/events", "POST")).toBe("calendarCreate");
    expect(resolveProxyAuditOperation("/api/community/calendar/events/cal_1", "PATCH")).toBe("calendarUpdate");
    expect(resolveProxyAuditOperation("/api/community/calendar/events/cal_1", "DELETE")).toBe("calendarDelete");
  });

  it("strips internal DB IDs in agent-facing CLI output for list/create/update/delete", async () => {
    const outputs: unknown[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "GET" && url.includes("/api/community/calendar/events")) {
        return Response.json({
          events: [sampleEvent],
          occurrences: [
            {
              eventId: "cal_test_1",
              occurrenceKey: "cal_test_1:2026-11-26T01:00:00.000Z",
              startAt: "2026-11-26T01:00:00.000Z",
              endAt: "2026-11-26T01:30:00.000Z",
              runStatus: "dispatched",
            },
          ],
          creators: [sampleEvent.createdBy],
        });
      }
      if (init?.method === "POST") {
        return Response.json({ event: sampleEvent }, { status: 201 });
      }
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body ?? "{}")) as { title?: string; ack?: true };
        return Response.json({
          event: {
            ...sampleEvent,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.ack
              ? {
                  lastExecution: {
                    ...sampleEvent.lastExecution!,
                    status: "completed" as const,
                    ackedAt: "2026-11-26T01:05:00.000Z",
                    updatedAt: "2026-11-26T01:05:00.000Z",
                  },
                }
              : {}),
          },
        });
      }
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    });

    const api = createProxyServerApi({ proxyUrl: "http://proxy.local", voucher: "vch_1", fetchImpl });

    const runCli = async (argv: string[]) => {
      outputs.length = 0;
      const program = new Command().exitOverride();
      registerCalendarCommands(program, () => api, (v) => outputs.push(v));
      await program.parseAsync(argv, { from: "user" });
      return outputs[0] as { success: Record<string, unknown> };
    };

    const listed = await runCli(["calendar", "list", "--creator", "@Elwira#8700"]);
    const rawListed = JSON.stringify(listed);
    expect(rawListed).not.toContain("u_bot_internal_1");
    expect(rawListed).not.toContain("msg_internal_99");
    expect(listed.success.creators).toEqual(["@Elwira#8700"]);

    const created = await runCli([
      "calendar",
      "create",
      "--title", "Weekly retro",
      "--at", "2026-11-26T09:00:00+08:00",
      "--tz", "Asia/Shanghai",
      "--message", "/Alook#5620/gus-infra#1801",
      "--repeat", "weekly",
      "--weekdays", "mon,wed,fri",
    ]);
    expect(JSON.stringify(created)).not.toContain("msg_internal_99");
    expect((created.success.event as { id: string; createdBy: string }).createdBy).toBe("@Elwira#8700");

    const updated = await runCli(["calendar", "update", "cal_test_1", "--title", "Weekly retro v2"]);
    expect((updated.success.event as { title: string }).title).toBe("Weekly retro v2");

    const acked = await runCli(["calendar", "update", "cal_test_1", "--ack"]);
    expect((acked.success.event as { lastExecution: { status: string; ackedAt?: string } }).lastExecution.status).toBe("completed");
    expect((acked.success.event as { lastExecution: { status: string; ackedAt?: string } }).lastExecution.ackedAt).toBeTruthy();

    const deleted = await runCli(["calendar", "delete", "cal_test_1"]);
    expect(deleted.success).toEqual({ deleted: true, id: "cal_test_1" });
  });

  it("delivers two recurring agent:event calendar triggers on the same bound message without WakeCoordinator suppression", async () => {
    const delivered: Array<{ agentId: string; id?: string; text: string }> = [];
    const manager = {
      register: vi.fn(),
      deliver: vi.fn((agentId: string, msg: { id?: string; text: string }) => {
        delivered.push({ agentId, ...msg });
        return true;
      }),
      liveSessionReports: () => [],
      liveAgentActivities: () => [],
    } as any;

    const socketListeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const fakeWs = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      on: (event: string, cb: (...args: unknown[]) => void) => {
        (socketListeners[event] ??= []).push(cb);
      },
      off: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    const channel = new WsControlChannel({
      url: "ws://local.test",
      headers: { Authorization: "Bearer cmk_1" },
      webSocketFactory: () => fakeWs as any,
    });
    const router = new AgentRouter({
      manager,
      channel,
      runtimeReport: [{ id: "codex", version: "1.0.0", status: "healthy" }],
      onBeforeAgent: async () => {},
    });

    channel.connect();
    await router.start();
    for (const cb of socketListeners.open ?? []) cb();

    const makeTrigger = (runId: string): Extract<HostCommand, { type: "agent:event" }> => ({
      type: "agent:event",
      agentId: "bot_1",
      config: makeRuntimeConfig({ runtime: "codex" }),
      launchId: `calrun_${runId}`,
      prompt: `[Scheduled Calendar Event — Execute Now]\nBound message: /Alook#5620/gus-infra#1801\nRun: ${runId}`,
    });

    for (const cb of socketListeners.message ?? []) {
      cb(JSON.stringify(makeTrigger("crun_occ_1")));
      cb(JSON.stringify(makeTrigger("crun_occ_2")));
    }

    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toHaveLength(2);
    expect(delivered.map((d) => d.id)).toEqual([
      "bot_1:event:calrun_crun_occ_1",
      "bot_1:event:calrun_crun_occ_2",
    ]);
    channel.close();
  });
});
