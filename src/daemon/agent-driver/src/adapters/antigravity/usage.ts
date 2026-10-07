import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import type { TokenUsageDelta, TokenUsageIdentity } from "../../contract.js";
import { readLocalCommand } from "./local-data.js";

type Field = { number: number; value: bigint | Uint8Array };
function fields(data: Uint8Array): Field[] {
  if (data.length > 4 * 1024 * 1024) throw new Error("Native usage record too large");
  let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= data.length) throw new Error("Truncated native usage record");
      const byte = data[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid native usage varint");
  };
  const result: Field[] = [];
  while (offset < data.length) {
    const tag = varint();
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!number || number > 536870911) throw new Error("Invalid native usage field");
    if (wire === 0) result.push({ number, value: varint() });
    else if (wire === 2) {
      const length = Number(varint());
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > data.length) throw new Error("Invalid native usage length");
      result.push({ number, value: data.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > data.length) throw new Error("Truncated native usage scalar");
    } else throw new Error("Unsupported native usage field");
  }
  return result;
}
function nested(data: Field[], number: number): Field[] {
  const value = data.filter((field) => field.number === number).at(-1)?.value;
  return value instanceof Uint8Array ? fields(value) : [];
}
function count(data: Field[], number: number): number | null {
  const value = data.filter((field) => field.number === number).at(-1)?.value;
  if (value === undefined) return null;
  if (typeof value !== "bigint" || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid native token count");
  return Number(value);
}

export function parseNativeGeneration(data: Uint8Array): { usage: TokenUsageDelta; occurredAt: string | null } {
  const chat = nested(fields(data), 1);
  const usage = nested(chat, 4);
  const timestamp = nested(nested(chat, 9), 4);
  const seconds = count(timestamp, 1);
  const nanos = count(timestamp, 2) ?? 0;
  const milliseconds = seconds === null ? NaN : seconds * 1000 + Math.floor(nanos / 1_000_000);
  const occurredAt = nanos < 1_000_000_000 && Number.isFinite(milliseconds) && milliseconds <= 8.64e15 ? new Date(milliseconds).toISOString() : null;
  return { usage: { input: count(usage, 2), output: count(usage, 3), cache: count(usage, 5) }, occurredAt };
}

export function nativeUsageHome(env: NodeJS.ProcessEnv, cwd: string): string {
  return resolve(cwd, env.GEMINI_HOME?.replace(/^~(?=[/\\]|$)/, homedir()) || join(homedir(), ".gemini"));
}

type Row = { idx: number; data: string; has_children: number };
type Database = { prepare(sql: string): { all(...params: unknown[]): unknown[] }; close(): void };
type Sqlite = { DatabaseSync: new(path: string, options: { readOnly: boolean }) => Database };
const QUERY = "WITH pending AS (SELECT idx,data FROM gen_metadata WHERE idx>? ORDER BY idx LIMIT 128), batch AS (SELECT idx,data,sum(length(data)) OVER (ORDER BY idx) AS bytes FROM pending) SELECT idx,hex(substr(data,1,4194305)) AS data,(SELECT COUNT(*) FROM steps WHERE has_subtrajectory=1) AS has_children FROM batch WHERE bytes<=4194304 OR idx=(SELECT min(idx) FROM batch) ORDER BY idx";

type NativeUsageBatch = { samples: { usage: TokenUsageDelta; identity: TokenUsageIdentity }[]; complete: boolean; incompleteScope?: true };

export class NativeUsageReader {
  private cursor = -1;
  private childTrajectories = false;
  constructor(private readonly home: string, private readonly sessionId: string, private readonly readRows = queryNativeRows) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) throw new Error("Invalid native usage session identity");
  }
  async read(): Promise<NativeUsageBatch> {
    const path = join(this.home, "antigravity-acp", "conversations", `${this.sessionId}.db`);
    let cursor = this.cursor;
    let complete = false;
    const result: { usage: TokenUsageDelta; identity: TokenUsageIdentity }[] = [];
    for (let batch = 0; batch < 16; batch++) {
      const rows = await this.readRows(path, cursor);
      for (const row of rows) {
        if (!Number.isSafeInteger(row.idx) || row.idx <= cursor || !/^(?:[a-f0-9]{2})*$/i.test(row.data) || row.data.length > 8 * 1024 * 1024) throw new Error("Invalid native usage row");
        if (row.has_children) this.childTrajectories = true;
        const parsed = parseNativeGeneration(Buffer.from(row.data, "hex"));
        if (!parsed.occurredAt) throw new Error("Native usage timestamp unavailable");
        result.push({ usage: row.has_children ? { input: null, output: null, cache: null } : parsed.usage, identity: { source: `antigravity:${createHash("sha256").update(this.home).digest("hex").slice(0, 16)}:${this.sessionId}`, index: row.idx, occurredAt: parsed.occurredAt } });
        cursor = row.idx;
      }
      if (!rows.length) { complete = true; break; }
    }
    this.cursor = cursor;
    return { samples: result, complete, ...(this.childTrajectories ? { incompleteScope: true as const } : {}) };
  }
}
export async function queryNativeRowsWithCli(path: string, cursor: number): Promise<Row[]> {
  const output = await readLocalCommand("sqlite3", ["-readonly", "-json", path, QUERY.replace("idx>?", `idx>${cursor}`)], 16 * 1024 * 1024);
  return output.trim() ? JSON.parse(output) as Row[] : [];
}

export async function queryNativeRows(path: string, cursor: number, loadSqlite: () => Promise<Sqlite> = async () => { const module = "node:sqlite"; return await import(module) as Sqlite; }): Promise<Row[]> {
  let sqlite: Sqlite;
  try { sqlite = await loadSqlite(); }
  catch { return queryNativeRowsWithCli(path, cursor); }
  const db = new sqlite.DatabaseSync(path, { readOnly: true });
  try { return db.prepare(QUERY).all(cursor) as Row[]; } finally { db.close(); }
}
