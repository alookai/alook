import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DailyTokenUsageStore } from "./dailyTokenUsage.js";

const roots: string[] = [];
const delta = (input: number, output: number, cache: number) => ({
  input,
  output,
  cache,
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DailyTokenUsageStore", () => {
  it("serializes concurrent bot updates into one atomic file", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-usage-"));
    roots.push(root);
    const now = new Date("2026-08-29T01:00:00Z");
    const store = new DailyTokenUsageStore(root, () => now, "UTC");
    await Promise.all([
      store.record("bot-a", delta(10, 3, 2)),
      store.record("bot-b", delta(20, 4, 5)),
      store.record("bot-a", delta(7, 6, 1)),
    ]);
    expect(await store.snapshots("bot-a")).toEqual([{
      botId: "bot-a",
      day: "2026-08-29",
      metrics: {
        input: 17,
        output: 9,
        cache: 3,
      },
    }]);
    expect(readdirSync(join(root, ".telemetry"))).toEqual(["daily-token-usage.json"]);
  });

  it.skipIf(process.platform === "win32")("writes the atomic file with 0600 permissions", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-usage-mode-"));
    roots.push(root);
    const store = new DailyTokenUsageStore(root, () => new Date("2026-08-29T01:00:00Z"), "UTC");
    await store.record("bot", delta(1, 2, 3));
    expect(statSync(join(root, ".telemetry", "daily-token-usage.json")).mode & 0o777).toBe(0o600);
  });

  it("retains complete snapshots across restart and UTC rollover", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-rollover-"));
    roots.push(root);
    let now = new Date("2026-08-29T23:59:59Z");
    const first = new DailyTokenUsageStore(root, () => now, "UTC");
    await first.record("bot", delta(10, 0, 0));

    const restarted = new DailyTokenUsageStore(root, () => now, "UTC");
    await restarted.record("bot", {
      input: 2,
      output: null,
      cache: 0,
    });
    await restarted.record("bot", { input: 0, output: 5, cache: 0 });
    now = new Date("2026-08-30T00:00:01Z");
    await restarted.record("bot", delta(5, 1, 0));
    expect(await restarted.snapshots("bot")).toEqual([
      {
        botId: "bot",
        day: "2026-08-29",
        metrics: {
          input: 12,
          output: null,
          cache: 0,
        },
      },
      {
        botId: "bot",
        day: "2026-08-30",
        metrics: {
          input: 5,
          output: 1,
          cache: 0,
        },
      },
    ]);
  });

  it("exposes 30 UTC days while retaining two recovery days", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-retention-"));
    roots.push(root);
    let now = new Date("2026-07-27T12:00:00Z");
    const store = new DailyTokenUsageStore(root, () => now, "UTC");
    for (let day = 0; day < 33; day += 1) {
      await store.record("bot", delta(day, day, day));
      now = new Date(now.getTime() + 86_400_000);
    }
    now = new Date("2026-08-28T12:00:00Z");
    const snapshots = await store.snapshots("bot");
    expect(snapshots).toHaveLength(30);
    expect(snapshots.at(0)?.day).toBe("2026-07-30");
    expect(snapshots.at(-1)?.day).toBe("2026-08-28");

    const persisted = JSON.parse(readFileSync(
      join(root, ".telemetry", "daily-token-usage.json"),
      "utf8",
    )) as { bots: Record<string, Array<{ day: string }>> };
    expect(persisted.bots.bot).toHaveLength(32);
    expect(persisted.bots.bot?.at(0)?.day).toBe("2026-07-28");
    expect(persisted.bots.bot?.at(-1)?.day).toBe("2026-08-28");
  });

  it("persists retention pruning even when a quiet bot only reconnects", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-quiet-prune-"));
    roots.push(root);
    let now = new Date("2026-08-20T12:00:00Z");
    const store = new DailyTokenUsageStore(root, () => now, "UTC");
    await store.record("bot", delta(1, 1, 1));

    now = new Date("2026-09-21T12:00:00Z");
    expect(await store.snapshots("bot")).toEqual([]);

    const persisted = JSON.parse(readFileSync(
      join(root, ".telemetry", "daily-token-usage.json"),
      "utf8",
    ));
    expect(persisted).toEqual({ version: 1, bots: {} });
  });

  it("does not replace malformed authoritative history", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-malformed-"));
    roots.push(root);
    const directory = join(root, ".telemetry");
    const filePath = join(directory, "daily-token-usage.json");
    mkdirSync(directory, { recursive: true });
    writeFileSync(filePath, "{not-json", "utf8");

    const store = new DailyTokenUsageStore(root, () => new Date(), "UTC");
    await expect(store.record("bot", delta(1, 2, 3))).rejects.toThrow();

    expect(readFileSync(filePath, "utf8")).toBe("{not-json");
    expect(readdirSync(directory)).toEqual(["daily-token-usage.json"]);
  });

  it("rolls over at the daemon computer's local midnight", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-local-rollover-"));
    roots.push(root);
    let now = new Date("2026-08-29T15:59:59Z");
    const store = new DailyTokenUsageStore(root, () => now, "Asia/Shanghai");
    await store.record("bot", delta(10, 2, 3));
    now = new Date("2026-08-29T16:00:01Z");
    await store.record("bot", delta(5, 1, 4));

    expect(await store.snapshots("bot")).toEqual([
      { botId: "bot", day: "2026-08-29", metrics: { input: 10, output: 2, cache: 3 } },
      { botId: "bot", day: "2026-08-30", metrics: { input: 5, output: 1, cache: 4 } },
    ]);
    expect(await store.usageWindow("bot")).toEqual({
      usageDay: "2026-08-30",
      usageTimeZone: "Asia/Shanghai",
      snapshots: [
        { botId: "bot", day: "2026-08-29", metrics: { input: 10, output: 2, cache: 3 } },
        { botId: "bot", day: "2026-08-30", metrics: { input: 5, output: 1, cache: 4 } },
      ],
    });
  });

  it("reports the local day even when that day has no completed usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-empty-local-day-"));
    roots.push(root);
    let now = new Date("2026-08-29T12:00:00Z");
    const store = new DailyTokenUsageStore(root, () => now, "Asia/Shanghai");
    await store.record("bot", delta(7, 3, 2));
    now = new Date("2026-08-29T16:00:01Z");

    expect(await store.usageWindow("bot")).toEqual({
      usageDay: "2026-08-30",
      usageTimeZone: "Asia/Shanghai",
      snapshots: [
        { botId: "bot", day: "2026-08-29", metrics: { input: 7, output: 3, cache: 2 } },
      ],
    });
  });

  it("follows a live computer-timezone change without deleting the prior day's totals", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-timezone-change-"));
    roots.push(root);
    let now = new Date("2026-07-31T16:00:01Z");
    let timeZone = "Asia/Shanghai";
    const store = new DailyTokenUsageStore(root, () => now, () => timeZone);
    for (let day = 1; day <= 30; day += 1) {
      now = new Date(new Date("2026-07-31T16:00:01Z").getTime() + (day - 1) * 86_400_000);
      await store.record("bot", delta(day, 2, 3));
    }

    now = new Date("2026-08-29T16:00:01Z");
    timeZone = "America/Los_Angeles";
    await store.record("bot", delta(5, 1, 4));

    const window = await store.usageWindow("bot");
    expect(window.usageDay).toBe("2026-08-29");
    expect(window.usageTimeZone).toBe("America/Los_Angeles");
    expect(window.snapshots).toHaveLength(29);
    expect(window.snapshots.at(0)?.day).toBe("2026-08-01");
    expect(window.snapshots.at(-1)?.day).toBe("2026-08-29");
    expect(window.snapshots.at(-1)?.metrics).toEqual({ input: 34, output: 3, cache: 7 });
    const persisted = JSON.parse(readFileSync(
      join(root, ".telemetry", "daily-token-usage.json"),
      "utf8",
    )) as { bots: Record<string, Array<{ day: string }>> };
    expect(persisted.bots.bot?.map((snapshot) => snapshot.day)).toContain("2026-08-30");
  });

  it("retains two recovery days across an exact UTC+14 to UTC-12 switch", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-extreme-timezone-change-"));
    roots.push(root);
    let now = new Date("2026-07-29T10:30:00Z");
    let timeZone = "Pacific/Kiritimati";
    const store = new DailyTokenUsageStore(root, () => now, () => timeZone);
    for (let offset = 0; offset < 32; offset += 1) {
      now = new Date(new Date("2026-07-29T10:30:00Z").getTime() + offset * 86_400_000);
      await store.record("bot", delta(offset, 2, 3));
    }

    now = new Date("2026-08-29T10:30:00Z");
    timeZone = "Etc/GMT+12";

    const window = await store.usageWindow("bot");
    expect(window.usageDay).toBe("2026-08-28");
    expect(window.usageTimeZone).toBe("Etc/GMT+12");
    expect(window.snapshots).toHaveLength(30);
    expect(window.snapshots.at(0)?.day).toBe("2026-07-30");
    expect(window.snapshots.at(-1)?.day).toBe("2026-08-28");
    const persisted = JSON.parse(readFileSync(
      join(root, ".telemetry", "daily-token-usage.json"),
      "utf8",
    )) as { bots: Record<string, Array<{ day: string }>> };
    expect(persisted.bots.bot).toHaveLength(32);
    expect(persisted.bots.bot?.at(0)?.day).toBe("2026-07-30");
    expect(persisted.bots.bot?.at(-1)?.day).toBe("2026-08-30");
  });
});
