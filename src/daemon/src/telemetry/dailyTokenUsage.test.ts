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
  it("serializes concurrent bot updates into one 0600 atomic file", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-usage-"));
    roots.push(root);
    const now = new Date("2026-08-29T01:00:00Z");
    const store = new DailyTokenUsageStore(root, () => now);
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
    expect((statSync(join(root, ".telemetry", "daily-token-usage.json")).mode & 0o777)).toBe(0o600);
    expect(readdirSync(join(root, ".telemetry"))).toEqual(["daily-token-usage.json"]);
  });

  it("retains complete snapshots across restart and UTC rollover", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-rollover-"));
    roots.push(root);
    let now = new Date("2026-08-29T23:59:59Z");
    const first = new DailyTokenUsageStore(root, () => now);
    await first.record("bot", delta(10, 0, 0));

    const restarted = new DailyTokenUsageStore(root, () => now);
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

  it("keeps only today and the previous six UTC days", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-retention-"));
    roots.push(root);
    let now = new Date("2026-08-20T12:00:00Z");
    const store = new DailyTokenUsageStore(root, () => now);
    for (let day = 0; day < 9; day += 1) {
      await store.record("bot", delta(day, day, day));
      now = new Date(now.getTime() + 86_400_000);
    }
    now = new Date("2026-08-28T12:00:00Z");
    const snapshots = await store.snapshots("bot");
    expect(snapshots).toHaveLength(7);
    expect(snapshots.map((snapshot) => snapshot.day)).toEqual([
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
    ]);
  });

  it("persists retention pruning even when a quiet bot only reconnects", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-token-quiet-prune-"));
    roots.push(root);
    let now = new Date("2026-08-20T12:00:00Z");
    const store = new DailyTokenUsageStore(root, () => now);
    await store.record("bot", delta(1, 1, 1));

    now = new Date("2026-08-29T12:00:00Z");
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

    const store = new DailyTokenUsageStore(root);
    await expect(store.record("bot", delta(1, 2, 3))).rejects.toThrow();

    expect(readFileSync(filePath, "utf8")).toBe("{not-json");
    expect(readdirSync(directory)).toEqual(["daily-token-usage.json"]);
  });
});
