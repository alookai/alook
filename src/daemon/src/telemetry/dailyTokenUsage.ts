import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TokenUsageDelta } from "@alook/agent-driver";
import { calendarDayKeyDaysAgo, dayKeyInTimeZone } from "@alook/shared";

const TOKEN_USAGE_WINDOW_DAYS = 30;
const TOKEN_USAGE_RECOVERY_DAYS = 2;
const TOKEN_USAGE_RETENTION_DAYS = TOKEN_USAGE_WINDOW_DAYS + TOKEN_USAGE_RECOVERY_DAYS;

export type DailyUsageMetric = number | null;

export interface DailyUsageSnapshot {
  botId: string;
  day: string;
  metrics: {
    input: DailyUsageMetric;
    output: DailyUsageMetric;
    cache: DailyUsageMetric;
  };
}

type UsageFile = {
  version: 1;
  bots: Record<string, DailyUsageSnapshot[]>;
};

function oldestRetainedDay(at: Date, timeZone: string): string {
  const today = dayKeyInTimeZone(at, timeZone);
  return calendarDayKeyDaysAgo(today, TOKEN_USAGE_RETENTION_DAYS - 1);
}

function oldestVisibleDay(today: string): string {
  return calendarDayKeyDaysAgo(today, TOKEN_USAGE_WINDOW_DAYS - 1);
}

function isMetric(value: unknown): value is DailyUsageMetric {
  return value === null
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isSnapshot(value: unknown): value is DailyUsageSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  const metrics = snapshot.metrics as Record<string, unknown> | undefined;
  return typeof snapshot.botId === "string"
    && snapshot.botId.length > 0
    && typeof snapshot.day === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(snapshot.day)
    && !!metrics
    && isMetric(metrics.input)
    && isMetric(metrics.output)
    && isMetric(metrics.cache);
}

function mergeMetric(
  existing: DailyUsageMetric,
  delta: TokenUsageDelta["input"],
  hasExistingSnapshot: boolean,
): DailyUsageMetric {
  if (delta === null) return null;
  if (!Number.isSafeInteger(delta) || delta < 0) {
    throw new RangeError("token usage delta must be a non-negative safe integer");
  }
  if (!hasExistingSnapshot) return delta;
  if (existing === null) return null;
  const sum = existing + delta;
  if (!Number.isSafeInteger(sum)) throw new RangeError("daily token usage exceeds safe integer range");
  return sum;
}

function emptySnapshot(botId: string, day: string): DailyUsageSnapshot {
  return {
    botId,
    day,
    metrics: {
      input: null,
      output: null,
      cache: null,
    },
  };
}

export class DailyTokenUsageStore {
  private tail: Promise<void> = Promise.resolve();
  private loaded = false;
  private data: UsageFile = { version: 1, bots: {} };
  private readonly filePath: string;
  private readonly resolveTimeZone: () => string;

  constructor(
    workingDirectoryBase: string,
    private readonly now: () => Date = () => new Date(),
    timeZone: string | (() => string) = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {
    this.resolveTimeZone = typeof timeZone === "string" ? () => timeZone : timeZone;
    void this.timeZone;
    this.filePath = join(workingDirectoryBase, ".telemetry", "daily-token-usage.json");
  }

  get timeZone(): string {
    const timeZone = this.resolveTimeZone();
    dayKeyInTimeZone(0, timeZone);
    return timeZone;
  }

  record(botId: string, delta: TokenUsageDelta): Promise<void> {
    return this.enqueue(async () => {
      await this.load();
      const at = this.now();
      const timeZone = this.timeZone;
      this.prune(at, timeZone);
      const day = dayKeyInTimeZone(at, timeZone);
      const snapshots = this.data.bots[botId] ?? [];
      const existing = snapshots.find((snapshot) => snapshot.day === day);
      const next = existing ?? emptySnapshot(botId, day);
      next.metrics = {
        input: mergeMetric(next.metrics.input, delta.input, existing !== undefined),
        output: mergeMetric(next.metrics.output, delta.output, existing !== undefined),
        cache: mergeMetric(next.metrics.cache, delta.cache, existing !== undefined),
      };
      if (!existing) snapshots.push(next);
      snapshots.sort((a, b) => a.day.localeCompare(b.day));
      this.data.bots[botId] = snapshots;
      await this.persist();
    });
  }

  snapshots(botId: string): Promise<DailyUsageSnapshot[]> {
    return this.usageWindow(botId).then((window) => window.snapshots);
  }

  usageWindow(botId: string): Promise<{
    usageDay: string;
    usageTimeZone: string;
    snapshots: DailyUsageSnapshot[];
  }> {
    let result: DailyUsageSnapshot[] = [];
    let usageDay = "";
    let usageTimeZone = "";
    return this.enqueue(async () => {
      await this.load();
      const at = this.now();
      const timeZone = this.timeZone;
      usageTimeZone = timeZone;
      usageDay = dayKeyInTimeZone(at, timeZone);
      if (this.prune(at, timeZone)) await this.persist();
      const oldestDay = oldestVisibleDay(usageDay);
      result = (this.data.bots[botId] ?? [])
        .filter((snapshot) => snapshot.day >= oldestDay && snapshot.day <= usageDay)
        .map((snapshot) => structuredClone(snapshot));
    }).then(() => ({
      usageDay,
      usageTimeZone,
      snapshots: result,
    }));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (
        !error
        || typeof error !== "object"
        || !("code" in error)
        || error.code !== "ENOENT"
      ) {
        throw error;
      }
      this.data = { version: 1, bots: {} };
      this.loaded = true;
      return;
    }

    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
      throw new Error("invalid daily token usage file version");
    }
    const bots = (parsed as { bots?: unknown }).bots;
    if (!bots || typeof bots !== "object" || Array.isArray(bots)) {
      throw new Error("invalid daily token usage bots map");
    }
    const valid: Record<string, DailyUsageSnapshot[]> = {};
    for (const [botId, value] of Object.entries(bots)) {
      if (
        !Array.isArray(value)
        || !value.every(isSnapshot)
        || value.some((snapshot) => snapshot.botId !== botId)
      ) {
        throw new Error(`invalid daily token usage snapshots for bot ${botId}`);
      }
      if (value.length > 0) {
        valid[botId] = value;
      }
    }
    this.data = { version: 1, bots: valid };
    this.loaded = true;
  }

  private prune(at: Date, timeZone: string): boolean {
    const oldestDay = oldestRetainedDay(at, timeZone);
    let changed = false;
    for (const [botId, snapshots] of Object.entries(this.data.bots)) {
      const retained = snapshots
        .filter((snapshot) => snapshot.day >= oldestDay)
        .sort((a, b) => a.day.localeCompare(b.day));
      if (
        retained.length !== snapshots.length
        || retained.some((snapshot, index) => snapshot !== snapshots[index])
      ) changed = true;
      if (retained.length === 0) delete this.data.bots[botId];
      else this.data.bots[botId] = retained;
    }
    return changed;
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(this.data), { encoding: "utf8" });
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
      try {
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch { }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}
