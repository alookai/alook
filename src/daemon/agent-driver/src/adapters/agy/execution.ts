import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Row = { idx: number; data: string; has_children: number };
type Database = { prepare(sql: string): { all(...params: unknown[]): unknown[] }; close(): void };
type Sqlite = { DatabaseSync: new(path: string, options: { readOnly: boolean }) => Database };
type PortableSqlite = new(path: string, options: { readonly: boolean; fileMustExist: boolean; timeout: number }) => Database;
type Checkpoint = { index: number; executionId: string | null; lastStepIndex: number };
type Execution = { executionId: string; reason: number; hasError: boolean; lastStepIndex: number };

export function agyStateHome(env: NodeJS.ProcessEnv, cwd: string): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return resolve(cwd, env.GEMINI_HOME?.trim().replace(/^~(?=[/\\]|$)/, home) || join(home, ".gemini"));
}

export function parseNativeExecution(data: Uint8Array): Execution {
  if (data.length > 1024 * 1024) throw new Error("Native execution record too large");
  let offset = 0;
  const fields = new Map<number, bigint | Uint8Array>();
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= data.length) throw new Error("Truncated native execution record");
      const byte = data[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid native execution varint");
  };
  while (offset < data.length) {
    const tag = varint();
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!number || number > 536870911) throw new Error("Invalid native execution field");
    if (wire === 0) fields.set(number, varint());
    else if (wire === 2) {
      const length = Number(varint());
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > data.length) throw new Error("Invalid native execution length");
      fields.set(number, data.subarray(offset, offset + length));
      offset += length;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > data.length) throw new Error("Truncated native execution scalar");
    } else throw new Error("Unsupported native execution field");
  }
  const reason = fields.get(1);
  const identity = fields.get(9);
  const error = fields.get(12);
  const executionId = identity instanceof Uint8Array ? new TextDecoder("utf-8", { fatal: true }).decode(identity) : "";
  if (typeof reason !== "bigint" || reason < 1n || reason > 11n || !/^[a-zA-Z0-9_-]{1,100}$/.test(executionId)) throw new Error("Native execution terminal identity unavailable");
  if (error !== undefined && !(error instanceof Uint8Array)) throw new Error("Invalid native execution error");
  const lastStep = fields.get(3) ?? 0n;
  if (typeof lastStep !== "bigint" || lastStep > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid native execution step index");
  return { executionId, reason: Number(reason), lastStepIndex: Number(lastStep), hasError: error instanceof Uint8Array && error.length > 0 };
}

export class NativeExecutionReader {
  private readonly path: string;
  constructor(home: string, sessionId: string, private readonly readRows = queryExecutionRows, private readonly continuations = false) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) throw new Error("Invalid native execution session identity");
    this.path = join(home, "antigravity-cli", "conversations", `${sessionId}.db`);
  }
  async checkpoint(): Promise<Checkpoint> {
    const rows = await this.readRows(this.path);
    if (rows.length > 1) throw new Error("Ambiguous native execution checkpoint");
    if (!rows.length) return { index: -1, executionId: null, lastStepIndex: -1 };
    const row = this.validate(rows[0]);
    const execution = parseNativeExecution(Buffer.from(row.data, "hex"));
    return { index: row.idx, executionId: execution.executionId, lastStepIndex: execution.lastStepIndex };
  }
  async terminal(checkpoint: Checkpoint): Promise<"success" | "interrupted" | "failed"> {
    const max = this.continuations ? 32 : 1;
    const rows = await this.readRows(this.path, checkpoint.index, checkpoint.lastStepIndex, undefined, max + 1);
    if (!rows.length || rows.length > max) throw new Error("Native execution terminal unavailable or ambiguous");
    let lastStep = checkpoint.lastStepIndex;
    const identities = new Set([checkpoint.executionId]);
    let outcome: "success" | "interrupted" | "failed" = "success";
    for (let index = 0; index < rows.length; index++) {
      const row = this.validate(rows[index]);
      const execution = parseNativeExecution(Buffer.from(row.data, "hex"));
      if (row.has_children !== 0) throw new Error("Native executor subtrajectory ownership cannot be verified");
      if (row.idx !== checkpoint.index + index + 1 || identities.has(execution.executionId) || this.continuations && execution.lastStepIndex <= lastStep) throw new Error("Native execution terminal does not belong to the new root");
      identities.add(execution.executionId);
      lastStep = execution.lastStepIndex;
      if (execution.hasError || (execution.reason !== 2 && execution.reason !== 4)) outcome = "failed";
      else if (execution.reason === 2 && outcome !== "failed") outcome = "interrupted";
    }
    return outcome;
  }
  private validate(row: Row): Row {
    if (!Number.isSafeInteger(row.idx) || row.idx < 0 || !/^(?:[a-f0-9]{2})+$/i.test(row.data) || row.data.length > 2 * 1024 * 1024) throw new Error("Invalid native execution row");
    return row;
  }
}

export async function openNativeExecutionDatabase(path: string, loadBuiltin: () => Promise<Sqlite> = async () => { const module = "node:sqlite"; return await import(module) as Sqlite; }): Promise<Database> {
  let sqlite: Sqlite;
  try { sqlite = await loadBuiltin(); }
  catch {
    const require = createRequire(import.meta.url);
    const Portable = require("better-sqlite3") as PortableSqlite;
    return new Portable(path, { readonly: true, fileMustExist: true, timeout: 0 });
  }
  return new sqlite.DatabaseSync(path, { readOnly: true });
}

export async function queryExecutionRows(path: string, after?: number, afterStep = -1, openDatabase = openNativeExecutionDatabase, maxRows = 2): Promise<Row[]> {
  if ((after !== undefined && (!Number.isSafeInteger(after) || after < -1)) || !Number.isSafeInteger(afterStep) || afterStep < -1) throw new Error("Invalid native execution cursor");
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 33) throw new Error("Invalid native execution read limit");
  const query = `SELECT idx,hex(substr(data,1,1048577)) AS data,${after === undefined ? "(SELECT EXISTS(SELECT 1 FROM steps WHERE idx<0 AND has_subtrajectory=1))" : `(SELECT EXISTS(SELECT 1 FROM steps WHERE idx>${afterStep} AND has_subtrajectory=1))`} AS has_children FROM executor_metadata ${after === undefined ? "ORDER BY idx DESC LIMIT 1" : `WHERE idx>${after} ORDER BY idx LIMIT ${maxRows}`}`;
  const db = await openDatabase(path);
  try { return db.prepare(query).all() as Row[]; } finally { db.close(); }
}

export class NativeSessionActivityReader {
  private readonly path: string;
  constructor(home: string, private readonly sessionId: string, private readonly version: string, private readonly openDatabase = openNativeExecutionDatabase) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) throw new Error("Invalid native activity session identity");
    this.path = join(home, "antigravity-cli", "conversation_summaries.db");
  }
  async activity(): Promise<"running" | "idle" | "unknown"> {
    if (this.version !== "1.5.16") return "unknown";
    const db = await this.openDatabase(this.path);
    try {
      const rows = db.prepare("SELECT status,not_fully_idle FROM conversation_summaries WHERE conversation_id = ? LIMIT 1").all(this.sessionId);
      const row = rows[0] as { status?: unknown; not_fully_idle?: unknown } | undefined;
      if (!row || (row.not_fully_idle !== 0 && row.not_fully_idle !== 1)) return "unknown";
      if (row.status === "CASCADE_RUN_STATUS_RUNNING") return "running";
      return row.status === "CASCADE_RUN_STATUS_IDLE" ? row.not_fully_idle ? "running" : "idle" : "unknown";
    } finally { db.close(); }
  }
}
