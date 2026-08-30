#!/usr/bin/env -S pnpm --dir src/daemon exec tsx

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

export type Metric = number | null;
export type UsageTriad = { input: Metric; output: Metric; cache: Metric };

type JsonRecord = Record<string, any>;
type Backend = "claude" | "codex" | "cursor" | "opencode" | "pi";

const execFileAsync = promisify(execFile);
const METRICS = ["input", "output", "cache"] as const;
const CLAUDE_COMPONENTS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
] as const;

function fail(message: string): never {
  throw new Error(`invalid benchmark artifact: ${message}`);
}

function object(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as JsonRecord;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a non-negative safe integer`);
  return Number(value);
}

function money(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${label} must be finite and non-negative`);
  return value;
}

function identityText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}

function add(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) fail(`${label} exceeds safe integer range`);
  return result;
}

function addMoney(left: number, right: number, label: string): number {
  return money(left + right, label);
}

function sumTriads(items: UsageTriad[]): UsageTriad {
  const result: UsageTriad = { input: 0, output: 0, cache: 0 };
  for (const metric of METRICS) {
    for (const item of items) {
      const value = item[metric];
      if (value === null) {
        result[metric] = null;
      } else if (result[metric] !== null) {
        result[metric] = add(result[metric], value, metric);
      }
    }
  }
  return result;
}

function exactCost(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(right) * 1e-9);
}

function redactText(value: unknown): string {
  return String(value ?? "")
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b(authorization)\b["']?\s*[:=]\s*["']?(?:bearer|basic)\s+[^\s"',;}\]]+/gi, "$1=__ALOOK_REDACTED__")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|secret|password)\b["']?\s*[:=]\s*["']?[^\s"',;}\]]+/gi, "$1=__ALOOK_REDACTED__")
    .replaceAll("__ALOOK_REDACTED__", "[REDACTED]")
    .slice(0, 500);
}

export function redactedStderrTail(chunks: string[], limit = 40): string[] {
  return chunks.flatMap((chunk) => chunk.split(/\r?\n/)).filter(Boolean).slice(-limit).map((line) => redactText(line));
}

export function redactedOutputTail(chunks: string[], limit = 40): JsonRecord[] {
  const lines = chunks.flatMap((chunk) => chunk.split(/\r?\n/)).filter(Boolean).slice(-limit);
  return lines.map((line) => {
    try {
      const record = object(JSON.parse(line), "raw output line");
      const result = record.result && typeof record.result === "object" && !Array.isArray(record.result) ? record.result : undefined;
      const error = record.error && typeof record.error === "object" && !Array.isArray(record.error) ? record.error : undefined;
      return {
        bytes: Buffer.byteLength(line),
        ...(typeof record.type === "string" ? { type: record.type } : {}),
        ...(typeof record.subtype === "string" ? { subtype: record.subtype } : {}),
        ...(typeof record.method === "string" ? { method: record.method } : {}),
        ...(typeof record.id === "number" || typeof record.id === "string" ? { id: record.id } : {}),
        ...(typeof record.session_id === "string" ? { sessionId: record.session_id } : {}),
        ...(result ? { resultKeys: Object.keys(result).sort(), ...(typeof result.stopReason === "string" ? { stopReason: result.stopReason } : {}) } : {}),
        ...(error ? { error: { code: error.code, message: redactText(error.message) } } : {}),
      };
    } catch {
      return { bytes: Buffer.byteLength(line), unparsed: true };
    }
  });
}

export function parseJsonRecords(text: string): JsonRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.map((item, index) => object(item, `record[${index}]`)) : [object(parsed, "record")];
  } catch {
    return trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return object(JSON.parse(line), `line[${index + 1}]`);
      } catch {
        return fail(`line ${index + 1} is not JSON`);
      }
    });
  }
}

type NativeTurn = {
  providerRecordIds: string[];
  providerModels: string[];
  nativeSourceName: string;
  nativeRaw: unknown;
  nativeReportedTotal: number | null;
  nativeReportedCost: number | null;
  derivedTotal: number;
  usage: UsageTriad;
};

export function extractClaude(records: JsonRecord[], launchId: string): NativeTurn[] {
  if (!launchId) fail("Claude launchId is required for cumulative modelUsage baselines");
  const terminals = records.filter((record) => record.type === "result" && record.modelUsage);
  if (terminals.length === 0) fail("Claude result.modelUsage is missing");
  const previous = new Map<string, Record<(typeof CLAUDE_COMPONENTS)[number], number> & { costUSD: number }>();
  const seen = new Set<string>();
  let pinnedSessionId: string | null = null;
  return terminals.map((terminal, terminalIndex) => {
    const sessionId = identityText(terminal.session_id, `Claude terminal ${terminalIndex + 1}.session_id`);
    const recordId = identityText(terminal.user_message_uuid ?? terminal.request_id, `Claude terminal ${terminalIndex + 1}.recordId`);
    if (pinnedSessionId === null) pinnedSessionId = sessionId;
    else if (sessionId !== pinnedSessionId) fail(`Claude session changed within physical launch ${launchId}`);
    const identity = `${launchId}:${sessionId}:${recordId}`;
    if (seen.has(identity)) fail(`duplicate Claude provider record ${recordId}`);
    seen.add(identity);

    const modelUsage = object(terminal.modelUsage, `Claude terminal ${recordId}.modelUsage`);
    if (Object.keys(modelUsage).length === 0) fail(`Claude terminal ${recordId}.modelUsage is empty`);
    const deltas: UsageTriad[] = [];
    let snapshotCost = 0;
    let deltaCost = 0;
    const rawModels: JsonRecord = {};
    for (const [model, raw] of Object.entries(modelUsage)) {
      identityText(model, `Claude terminal ${recordId}.model`);
      const usage = object(raw, `Claude modelUsage.${model}`);
      const current = {
        inputTokens: count(usage.inputTokens, `${model}.inputTokens`),
        outputTokens: count(usage.outputTokens, `${model}.outputTokens`),
        cacheReadInputTokens: count(usage.cacheReadInputTokens, `${model}.cacheReadInputTokens`),
        cacheCreationInputTokens: count(usage.cacheCreationInputTokens, `${model}.cacheCreationInputTokens`),
        costUSD: money(usage.costUSD, `${model}.costUSD`),
      };
      const prior = previous.get(model) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
      };
      for (const component of CLAUDE_COMPONENTS) {
        if (current[component] < prior[component]) fail(`Claude ${model}.${component} regressed within launch ${launchId}`);
      }
      if (current.costUSD < prior.costUSD) fail(`Claude ${model}.costUSD regressed within launch ${launchId}`);
      deltas.push({
        input: current.inputTokens - prior.inputTokens,
        output: current.outputTokens - prior.outputTokens,
        cache: add(
          current.cacheReadInputTokens - prior.cacheReadInputTokens,
          current.cacheCreationInputTokens - prior.cacheCreationInputTokens,
          "Claude cache delta",
        ),
      });
      snapshotCost = addMoney(snapshotCost, current.costUSD, "Claude snapshot cost");
      deltaCost = addMoney(deltaCost, current.costUSD - prior.costUSD, "Claude delta cost");
      previous.set(model, current);
      rawModels[model] = current;
    }
    for (const model of previous.keys()) {
      if (!(model in modelUsage)) fail(`Claude cumulative snapshot dropped model ${model}`);
    }
    const reportedCost = money(terminal.total_cost_usd, `Claude terminal ${recordId}.total_cost_usd`);
    if (!exactCost(snapshotCost, reportedCost)) fail(`Claude modelUsage cost does not equal terminal total_cost_usd for ${recordId}`);
    const usage = sumTriads(deltas);
    const derivedTotal = add(add(usage.input ?? 0, usage.output ?? 0, "Claude total"), usage.cache ?? 0, "Claude total");
    return {
      providerRecordIds: [recordId],
      providerModels: Object.keys(modelUsage).sort(),
      nativeSourceName: "claude_result_model_usage_cumulative_delta",
      nativeRaw: { launchId, sessionId, recordId, modelUsage: rawModels, total_cost_usd: reportedCost },
      nativeReportedTotal: null,
      nativeReportedCost: deltaCost,
      derivedTotal,
      usage,
    };
  });
}

export function extractCodex(records: JsonRecord[]): NativeTurn[] {
  const settled = records.filter((record) => record.method === "rawResponse/completed");
  if (settled.length === 0) fail("Codex rawResponse/completed is missing");
  const seen = new Set<string>();
  const providerValue = records.find((record) => record.type === "session_meta")?.payload?.model_provider;
  const provider = providerValue === undefined ? undefined : identityText(providerValue, "Codex model provider");
  const observedModels = new Set<string>();
  for (const record of records) {
    const model = record.type === "turn_context" ? record.payload?.model : undefined;
    if (model !== undefined) {
      const name = identityText(model, "Codex turn model");
      observedModels.add(provider ? `${provider}/${name}` : name);
    }
  }
  const groups = new Map<string, { ids: string[]; models: Set<string>; raw: unknown[]; usages: UsageTriad[]; reported: number[] }>();
  let pinnedThreadId: string | null = null;
  for (const record of settled) {
    const params = object(record.params, "Codex rawResponse/completed.params");
    const usage = object(params.usage, "Codex rawResponse/completed.usage");
    const threadId = String(params.threadId ?? "");
    const turnId = String(params.turnId ?? "");
    const responseId = String(params.responseId ?? params.response?.id ?? "");
    if (!threadId || !turnId || !responseId) fail("Codex settled record lacks threadId, turnId, or responseId");
    if (pinnedThreadId === null) pinnedThreadId = threadId;
    else if (threadId !== pinnedThreadId) fail(`Codex settled records crossed threads ${pinnedThreadId} and ${threadId}`);
    const identity = `${threadId}:${responseId}`;
    if (seen.has(identity)) fail(`duplicate Codex provider record ${identity}`);
    seen.add(identity);
    const input = count(usage.inputTokens, `${identity}.inputTokens`);
    const cached = count(usage.cachedInputTokens, `${identity}.cachedInputTokens`);
    const cacheWrite = count(usage.cacheWriteInputTokens ?? 0, `${identity}.cacheWriteInputTokens`);
    const output = count(usage.outputTokens, `${identity}.outputTokens`);
    const reasoning = count(usage.reasoningOutputTokens, `${identity}.reasoningOutputTokens`);
    const total = count(usage.totalTokens, `${identity}.totalTokens`);
    const cache = add(cached, cacheWrite, "Codex cache");
    if (cache > input) fail(`Codex cached input exceeds input for ${identity}`);
    if (reasoning > output) fail(`Codex reasoning exceeds output for ${identity}`);
    if (total !== add(input, output, "Codex provider total")) fail(`Codex totalTokens does not equal inputTokens + outputTokens for ${identity}`);
    const groupKey = `${threadId}:${turnId}`;
    const group = groups.get(groupKey) ?? { ids: [], models: new Set<string>(observedModels), raw: [], usages: [], reported: [] };
    group.ids.push(responseId);
    if (params.model !== undefined) group.models.add(identityText(params.model, `${identity}.model`));
    group.raw.push({ threadId, turnId, responseId, usage: { inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: cacheWrite, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: total } });
    group.usages.push({ input: input - cache, output, cache });
    group.reported.push(total);
    groups.set(groupKey, group);
  }
  const turns = [...groups.entries()].map(([groupKey, group]) => ({
    providerRecordIds: group.ids,
    providerModels: [...group.models].sort(),
    nativeSourceName: "codex_raw_response_completed",
    nativeRaw: { threadTurn: groupKey, records: group.raw },
    nativeReportedTotal: group.reported.reduce((sum, value) => add(sum, value, "Codex reported total"), 0),
    nativeReportedCost: null,
    derivedTotal: group.reported.reduce((sum, value) => add(sum, value, "Codex derived total"), 0),
    usage: sumTriads(group.usages),
  }));
  if (turns.some((turn) => turn.providerModels.length === 0)) fail("Codex provider model identity is missing");
  return turns;
}

export function extractOpenCode(exportRecord: JsonRecord): NativeTurn[] {
  const session = object(exportRecord.info, "OpenCode export.info");
  if (!session.id) fail("OpenCode export session id is missing");
  if (!Array.isArray(exportRecord.messages)) fail("OpenCode export.messages is missing");
  const seen = new Set<string>();
  const usages: UsageTriad[] = [];
  const raw: unknown[] = [];
  const ids: string[] = [];
  const models = new Set<string>();
  let reportedTotal = 0;
  let reportedCost = 0;
  for (const messageValue of exportRecord.messages) {
    const message = object(messageValue, "OpenCode message");
    const info = object(message.info, "OpenCode message.info");
    if (!Array.isArray(message.parts)) continue;
    for (const partValue of message.parts) {
      const part = object(partValue, "OpenCode part");
      if (part.type !== "step-finish") continue;
      const provider = identityText(info.providerID, `OpenCode ${part.id ?? "step-finish"}.providerID`);
      const model = identityText(info.modelID, `OpenCode ${part.id ?? "step-finish"}.modelID`);
      models.add(`${provider}/${model}`);
      const id = String(part.id ?? "");
      if (!id) fail("OpenCode step-finish id is missing");
      if (seen.has(id)) fail(`duplicate OpenCode provider record ${id}`);
      seen.add(id);
      const tokens = object(part.tokens, `OpenCode ${id}.tokens`);
      const cache = object(tokens.cache, `OpenCode ${id}.tokens.cache`);
      const input = count(tokens.input, `${id}.tokens.input`);
      const output = count(tokens.output, `${id}.tokens.output`);
      const reasoning = count(tokens.reasoning, `${id}.tokens.reasoning`);
      const read = count(cache.read, `${id}.tokens.cache.read`);
      const write = count(cache.write, `${id}.tokens.cache.write`);
      const triad = { input, output: add(output, reasoning, "OpenCode output"), cache: add(read, write, "OpenCode cache") };
      const providerTotal = count(tokens.total, `${id}.tokens.total`);
      const derivedTotal = add(add(triad.input, triad.output, "OpenCode total"), triad.cache, "OpenCode total");
      if (providerTotal !== derivedTotal) fail(`OpenCode provider total mismatch for ${id}`);
      const providerCost = money(part.cost, `${id}.cost`);
      usages.push(triad);
      reportedTotal = add(reportedTotal, providerTotal, "OpenCode reported total");
      reportedCost = addMoney(reportedCost, providerCost, "OpenCode reported cost");
      ids.push(id);
      raw.push({ sessionId: session.id, id, messageID: part.messageID, cost: providerCost, tokens: { total: providerTotal, input, output, reasoning, cache: { read, write } } });
    }
  }
  if (ids.length === 0) {
    const shape = exportRecord.messages.map((message: any) => ({
      keys: Object.keys(message ?? {}),
      partTypes: Array.isArray(message?.parts) ? message.parts.map((part: any) => part?.type) : [],
    }));
    fail(`OpenCode export has no step-finish records; message shape ${JSON.stringify(shape)}`);
  }
  return [{
    providerRecordIds: ids,
    providerModels: [...models].sort(),
    nativeSourceName: "opencode_export_step_finish",
    nativeRaw: { sessionId: session.id, records: raw },
    nativeReportedTotal: reportedTotal,
    nativeReportedCost: reportedCost,
    derivedTotal: reportedTotal,
    usage: sumTriads(usages),
  }];
}

export function extractOpenCodeEvents(rows: JsonRecord[], expectedSessionId: string): NativeTurn[] {
  const sessionId = identityText(expectedSessionId, "OpenCode session id");
  const modelsByMessage = new Map<string, string>();
  for (const row of rows) {
    if (row.type !== "session.next.step.started.1") continue;
    const data = typeof row.data === "string" ? object(JSON.parse(row.data), `OpenCode event ${row.seq}.data`) : object(row.data, `OpenCode event ${row.seq}.data`);
    if (identityText(data.sessionID, `OpenCode event ${row.seq}.sessionID`) !== sessionId) fail("OpenCode event crossed sessions");
    const messageId = identityText(data.assistantMessageID, `OpenCode event ${row.seq}.assistantMessageID`);
    const model = object(data.model, `OpenCode event ${row.seq}.model`);
    const providerModel = `${identityText(model.providerID, `OpenCode event ${row.seq}.providerID`)}/${identityText(model.id, `OpenCode event ${row.seq}.modelID`)}`;
    const prior = modelsByMessage.get(messageId);
    if (prior && prior !== providerModel) fail(`OpenCode model changed for ${messageId}`);
    modelsByMessage.set(messageId, providerModel);
  }

  const ids: string[] = [];
  const models = new Set<string>();
  const raw: unknown[] = [];
  const usages: UsageTriad[] = [];
  const seen = new Set<string>();
  let reportedTotal = 0;
  let hasReportedTotal = false;
  let hasMissingTotal = false;
  let reportedCost = 0;
  for (const row of rows) {
    if (row.type !== "session.next.step.ended.2") continue;
    const seq = count(row.seq, "OpenCode event seq");
    const data = typeof row.data === "string" ? object(JSON.parse(row.data), `OpenCode event ${seq}.data`) : object(row.data, `OpenCode event ${seq}.data`);
    if (identityText(data.sessionID, `OpenCode event ${seq}.sessionID`) !== sessionId) fail("OpenCode event crossed sessions");
    const messageId = identityText(data.assistantMessageID, `OpenCode event ${seq}.assistantMessageID`);
    const recordId = `${sessionId}:${messageId}:${seq}`;
    if (seen.has(recordId)) fail(`duplicate OpenCode provider record ${recordId}`);
    seen.add(recordId);
    const providerModel = modelsByMessage.get(messageId);
    if (!providerModel) fail(`OpenCode ended event ${messageId} has no matching model-bearing started event`);
    models.add(providerModel);
    const tokens = object(data.tokens, `OpenCode event ${seq}.tokens`);
    const cache = object(tokens.cache, `OpenCode event ${seq}.tokens.cache`);
    const input = count(tokens.input, `${recordId}.tokens.input`);
    const output = count(tokens.output, `${recordId}.tokens.output`);
    const reasoning = count(tokens.reasoning, `${recordId}.tokens.reasoning`);
    const read = count(cache.read, `${recordId}.tokens.cache.read`);
    const write = count(cache.write, `${recordId}.tokens.cache.write`);
    const triad = { input, output: add(output, reasoning, "OpenCode output"), cache: add(read, write, "OpenCode cache") };
    const derived = add(add(triad.input, triad.output, "OpenCode total"), triad.cache, "OpenCode total");
    if (tokens.total === undefined) {
      hasMissingTotal = true;
    } else {
      hasReportedTotal = true;
      const total = count(tokens.total, `${recordId}.tokens.total`);
      if (total !== derived) fail(`OpenCode provider total mismatch for ${recordId}`);
      reportedTotal = add(reportedTotal, total, "OpenCode reported total");
    }
    const cost = money(data.cost, `${recordId}.cost`);
    reportedCost = addMoney(reportedCost, cost, "OpenCode reported cost");
    usages.push(triad);
    ids.push(recordId);
    raw.push({ seq, sessionId, assistantMessageID: messageId, finish: data.finish, cost, tokens });
  }
  if (ids.length === 0) fail("OpenCode v2 event log has no ended step records");
  if (hasReportedTotal && hasMissingTotal) fail("OpenCode v2 event log mixes present and missing provider totals");
  const usage = sumTriads(usages);
  const derivedTotal = add(add(usage.input ?? 0, usage.output ?? 0, "OpenCode aggregate total"), usage.cache ?? 0, "OpenCode aggregate total");
  return [{
    providerRecordIds: ids,
    providerModels: [...models].sort(),
    nativeSourceName: "opencode_v2_step_ended_event",
    nativeRaw: { sessionId, records: raw },
    nativeReportedTotal: hasReportedTotal ? reportedTotal : null,
    nativeReportedCost: reportedCost,
    derivedTotal,
    usage,
  }];
}

export function extractPi(records: JsonRecord[]): NativeTurn[] {
  const session = records.find((record) => record.type === "session");
  const sessionId = String(session?.id ?? "");
  if (!sessionId) fail("Pi session identity is missing");
  const seen = new Set<string>();
  const ids: string[] = [];
  const models = new Set<string>();
  const raw: unknown[] = [];
  const usages: UsageTriad[] = [];
  let reportedTotal = 0;
  let reportedCost = 0;
  for (const record of records) {
    if (record.type !== "message" || record.message?.role !== "assistant" || !record.message?.usage) continue;
    const id = String(record.message.responseId ?? record.id ?? "");
    if (!id) fail("Pi assistant record id is missing");
    if (seen.has(id)) fail(`duplicate Pi provider record ${id}`);
    seen.add(id);
    const usage = object(record.message.usage, `Pi ${id}.usage`);
    const input = count(usage.input, `${id}.usage.input`);
    const output = count(usage.output, `${id}.usage.output`);
    const read = count(usage.cacheRead, `${id}.usage.cacheRead`);
    const write = count(usage.cacheWrite, `${id}.usage.cacheWrite`);
    const total = count(usage.totalTokens, `${id}.usage.totalTokens`);
    const derivedTotal = add(add(add(input, output, "Pi total"), read, "Pi total"), write, "Pi total");
    if (total !== derivedTotal) fail(`Pi totalTokens mismatch for ${id}`);
    const cost = object(usage.cost, `Pi ${id}.usage.cost`);
    const costTotal = money(cost.total, `${id}.usage.cost.total`);
    const componentCost = addMoney(
      addMoney(money(cost.input, `${id}.usage.cost.input`), money(cost.output, `${id}.usage.cost.output`), "Pi component cost"),
      addMoney(money(cost.cacheRead, `${id}.usage.cost.cacheRead`), money(cost.cacheWrite, `${id}.usage.cost.cacheWrite`), "Pi component cost"),
      "Pi component cost",
    );
    if (!exactCost(componentCost, costTotal)) fail(`Pi cost total mismatch for ${id}`);
    ids.push(id);
    const provider = identityText(record.message.provider, `Pi ${id}.provider`);
    const model = identityText(record.message.model, `Pi ${id}.model`);
    models.add(`${provider}/${model}`);
    usages.push({ input, output, cache: add(read, write, "Pi cache") });
    reportedTotal = add(reportedTotal, total, "Pi reported total");
    reportedCost = addMoney(reportedCost, costTotal, "Pi reported cost");
    raw.push({ id, provider: record.message.provider, model: record.message.model, usage });
  }
  if (ids.length === 0) fail("Pi session has no settled assistant messages");
  return [{
    providerRecordIds: ids,
    providerModels: [...models].sort(),
    nativeSourceName: "pi_session_assistant_message",
    nativeRaw: { sessionId, records: raw },
    nativeReportedTotal: reportedTotal,
    nativeReportedCost: reportedCost,
    derivedTotal: reportedTotal,
    usage: sumTriads(usages),
  }];
}

export function dailyDelta(before: UsageTriad | null, after: UsageTriad | null): UsageTriad {
  if (!after) fail("Alook after snapshot is missing");
  const baseline = before ?? { input: 0, output: 0, cache: 0 };
  const delta: UsageTriad = { input: 0, output: 0, cache: 0 };
  for (const metric of METRICS) {
    const start = baseline[metric];
    const end = after[metric];
    if (start === null) {
      if (end !== null) fail(`Alook ${metric} changed from null to numeric`);
      delta[metric] = null;
    } else if (end === null) {
      delta[metric] = null;
    } else {
      count(start, `Alook ${metric} before`);
      count(end, `Alook ${metric} after`);
      if (end < start) fail(`Alook ${metric} counter regressed`);
      delta[metric] = end - start;
    }
  }
  return delta;
}

export function compareUsage(native: UsageTriad, alook: UsageTriad): { exact: boolean; differences: UsageTriad } {
  const differences: UsageTriad = { input: null, output: null, cache: null };
  let exact = true;
  for (const metric of METRICS) {
    if (native[metric] === null || alook[metric] === null) {
      differences[metric] = native[metric] === alook[metric] ? 0 : null;
      exact &&= native[metric] === alook[metric];
    } else {
      differences[metric] = alook[metric] - native[metric];
      exact &&= differences[metric] === 0;
    }
  }
  return { exact, differences };
}

const ACTIVE_TRANSPORT: Record<Backend, string> = {
  claude: "persistent_stream_json",
  codex: "persistent_app_server_json_rpc",
  cursor: "persistent_acp_v1",
  opencode: "persistent_v2_http_sse",
  pi: "persistent_in_process_sdk",
};

function backendConfig(backend: Backend): any {
  const model = { kind: "default" } as const;
  if (backend === "claude") return { model, provider: { kind: "default" }, mode: "default" };
  if (backend === "codex") return { model, mode: "default" };
  if (backend === "pi") return { model, provider: { kind: "default" } };
  return { model };
}

async function findPiSession(sessionId: string): Promise<string> {
  const root = join(homedir(), ".pi", "agent", "sessions");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(`_${sessionId}.jsonl`));
  if (!match) fail(`Pi session file not found for ${sessionId}`);
  return join(match.parentPath, match.name);
}

async function findCodexSession(sessionId: string): Promise<string> {
  const root = join(homedir(), ".codex", "sessions");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`));
  if (!match) fail(`Codex session file not found for ${sessionId}`);
  return join(match.parentPath, match.name);
}

export type NativeReadProof = {
  callId: string;
  path: string;
  status: "success" | "failed";
  source: string;
};

function packageJsonPath(value: unknown): string | null {
  if (typeof value === "string") return /(?:^|[/\\])package\.json(?:$|[\s'"`])/i.test(value) ? "./package.json" : null;
  if (!value || typeof value !== "object") return null;
  for (const child of Array.isArray(value) ? value : Object.values(value as JsonRecord)) {
    const path = packageJsonPath(child);
    if (path) return path;
  }
  return null;
}

function containsBenchmarkCanary(value: unknown): boolean {
  return JSON.stringify(value).includes("alook-token-benchmark");
}

export function extractClaudeReadProofs(records: JsonRecord[]): NativeReadProof[] {
  const calls = new Map<string, string>();
  const results = new Map<string, { failed: boolean; hasCanary: boolean }>();
  for (const record of records) {
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use") {
        const path = /read/i.test(String(block.name ?? "")) ? packageJsonPath(block.input) : null;
        if (path) calls.set(identityText(block.id, "Claude tool_use.id"), path);
      }
      if (block?.type === "tool_result") {
        const callId = identityText(block.tool_use_id, "Claude tool_result.tool_use_id");
        results.set(callId, { failed: block.is_error === true, hasCanary: containsBenchmarkCanary(block.content) });
      }
    }
  }
  return [...calls].map(([callId, path]) => {
    const result = results.get(callId);
    return { callId, path, status: result && !result.failed && result.hasCanary ? "success" : "failed", source: "claude_tool_use_result" };
  });
}

export function extractCodexReadProofs(records: JsonRecord[]): NativeReadProof[] {
  const calls = new Map<string, string>();
  const outputs = new Map<string, unknown>();
  for (const record of records) {
    const payload = record.payload;
    if (record.type !== "response_item" || !payload) continue;
    if (payload.type === "custom_tool_call" && payload.status === "completed") {
      const path = packageJsonPath(payload.input);
      if (path) calls.set(identityText(payload.call_id, "Codex custom_tool_call.call_id"), path);
    }
    if (payload.type === "custom_tool_call_output") {
      outputs.set(identityText(payload.call_id, "Codex custom_tool_call_output.call_id"), payload.output);
    }
  }
  return [...calls].map(([callId, path]) => {
    const output = outputs.get(callId);
    const succeeded = output !== undefined && containsBenchmarkCanary(output);
    return { callId, path, status: succeeded ? "success" : "failed", source: "codex_custom_tool_call_output" };
  });
}

export function extractOpenCodeReadProofs(rows: JsonRecord[], expectedSessionId: string): NativeReadProof[] {
  const sessionId = identityText(expectedSessionId, "OpenCode session id");
  const calls = new Map<string, string>();
  const results = new Map<string, "success" | "failed">();
  for (const row of rows) {
    if (!/^session\.next\.tool\.(?:called|success|failed)\.1$/.test(String(row.type))) continue;
    const data = typeof row.data === "string" ? object(JSON.parse(row.data), `OpenCode event ${row.seq}.data`) : object(row.data, `OpenCode event ${row.seq}.data`);
    if (identityText(data.sessionID, `OpenCode event ${row.seq}.sessionID`) !== sessionId) fail("OpenCode tool event crossed sessions");
    const callId = identityText(data.callID, `OpenCode event ${row.seq}.callID`);
    if (row.type === "session.next.tool.called.1") {
      const path = /read/i.test(String(data.tool ?? "")) ? packageJsonPath(data.input) : null;
      if (path) calls.set(callId, path);
    } else {
      results.set(callId, row.type === "session.next.tool.success.1" && containsBenchmarkCanary(data) ? "success" : "failed");
    }
  }
  return [...calls].map(([callId, path]) => ({ callId, path, status: results.get(callId) ?? "failed", source: "opencode_v2_tool_event" }));
}

export function extractPiReadProofs(records: JsonRecord[]): NativeReadProof[] {
  const calls = new Map<string, string>();
  const results = new Map<string, { failed: boolean; hasCanary: boolean }>();
  for (const record of records) {
    const message = record.message;
    if (record.type !== "message" || !message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        const path = block?.type === "toolCall" && /read/i.test(String(block.name ?? "")) ? packageJsonPath(block.arguments) : null;
        if (path) calls.set(identityText(block.id, "Pi toolCall.id"), path);
      }
    }
    if (message.role === "toolResult") {
      results.set(identityText(message.toolCallId, "Pi toolResult.toolCallId"), {
        failed: message.isError === true,
        hasCanary: containsBenchmarkCanary(message.content),
      });
    }
  }
  return [...calls].map(([callId, path]) => {
    const result = results.get(callId);
    return { callId, path, status: result && !result.failed && result.hasCanary ? "success" : "failed", source: "pi_tool_call_result" };
  });
}

type NativeEvidence = { turns: NativeTurn[]; readProofs: NativeReadProof[] };

async function nativeEvidence(backend: Exclude<Backend, "cursor">, rawLines: string[], launchId: string, sessionId: string, cwd: string): Promise<NativeEvidence> {
  if (backend === "claude") {
    const records = parseJsonRecords(rawLines.join("\n"));
    return { turns: extractClaude(records, launchId), readProofs: extractClaudeReadProofs(records) };
  }
  if (backend === "codex") {
    const file = await findCodexSession(sessionId);
    const records = [...parseJsonRecords(rawLines.join("\n")), ...parseJsonRecords(await readFile(file, "utf8"))];
    return { turns: extractCodex(records), readProofs: extractCodexReadProofs(records) };
  }
  if (backend === "opencode") {
    if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) fail("OpenCode session id is unsafe for native DB query");
    const query = `select seq, type, data from event where aggregate_id='${sessionId}' order by seq`;
    const { stdout } = await execFileAsync("opencode", ["db", query, "--format", "json"], { cwd, maxBuffer: 16 * 1024 * 1024 });
    const rows = parseJsonRecords(stdout);
    return { turns: extractOpenCodeEvents(rows, sessionId), readProofs: extractOpenCodeReadProofs(rows, sessionId) };
  }
  const file = await findPiSession(sessionId);
  const records = parseJsonRecords(await readFile(file, "utf8"));
  return { turns: extractPi(records), readProofs: extractPiReadProofs(records) };
}

function usageForDay(snapshots: Array<{ day: string; metrics: UsageTriad }>, day: string): UsageTriad | null {
  return snapshots.find((snapshot) => snapshot.day === day)?.metrics ?? null;
}

type WorkloadObservation = {
  terminalOutcome: string;
  terminalErrorCode?: string;
  assistantMessages: string[];
  readProofs: NativeReadProof[];
};

export function validateWorkload(observation: WorkloadObservation): void {
  if (observation.terminalOutcome !== "success") {
    fail(`workload terminal outcome was ${observation.terminalOutcome}${observation.terminalErrorCode ? ` (${observation.terminalErrorCode})` : ""}`);
  }
  if (!observation.readProofs.some((proof) => proof.status === "success" && proof.path === "./package.json")) {
    fail(`workload did not prove a successful package.json read on the same native call; observed ${JSON.stringify(observation.readProofs)}`);
  }
  if (observation.assistantMessages.at(-1)?.trim() !== "BENCHMARK_OK") {
    fail("workload did not end with the exact BENCHMARK_OK marker");
  }
}

function usageBearingPaths(value: unknown, path = "result"): string[] {
  if (!value || typeof value !== "object") return [];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    const childPath = `${path}.${key}`;
    if (/token|usage/i.test(key)) paths.push(childPath);
    paths.push(...usageBearingPaths(child, childPath));
  }
  return paths;
}

export function extractCursorTerminal(records: JsonRecord[]): JsonRecord {
  const candidates = records
    .map((record) => record.result)
    .filter((result): result is JsonRecord => Boolean(result) && typeof result === "object" && !Array.isArray(result) && typeof result.stopReason === "string");
  if (candidates.length !== 1) fail(`Cursor ACP expected exactly one terminal result.stopReason response, observed ${candidates.length}`);
  const stopReason = identityText(candidates[0].stopReason, "Cursor ACP result.stopReason");
  if (!(new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"])).has(stopReason)) {
    fail(`Cursor ACP result.stopReason is unsupported: ${stopReason}`);
  }
  const usagePaths = usageBearingPaths(candidates[0]);
  if (usagePaths.length > 0) fail(`Cursor ACP terminal result now exposes usage-bearing fields: ${usagePaths.join(", ")}`);
  return { stopReason };
}

export function extractCursorToolEvidence(records: JsonRecord[]): Pick<WorkloadObservation, "readProofs" | "assistantMessages"> {
  const calls = new Map<string, string>();
  const results = new Map<string, "success" | "failed">();
  let lastCompletedToolIndex = -1;
  for (const [index, record] of records.entries()) {
    if (record.method !== "session/update") continue;
    const update = record.params?.update;
    if (!update || (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")) continue;
    const callId = identityText(update.toolCallId, "Cursor ACP toolCallId");
    const path = packageJsonPath(update.rawInput) ?? packageJsonPath(update.locations);
    if (path) calls.set(callId, path);
    if (update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
      results.set(callId, update.status === "completed" && containsBenchmarkCanary(update.rawOutput) ? "success" : "failed");
    }
    if (update.sessionUpdate === "tool_call_update" && update.status === "completed") {
      lastCompletedToolIndex = index;
    }
  }
  const finalAssistantText = records.slice(lastCompletedToolIndex + 1)
    .filter((record) => record.method === "session/update" && record.params?.update?.sessionUpdate === "agent_message_chunk")
    .map((record) => record.params.update.content?.text)
    .filter((value): value is string => typeof value === "string")
    .join("");
  const readProofs = [...calls].map(([callId, path]) => ({ callId, path, status: results.get(callId) ?? "failed", source: "cursor_acp_tool_update" }) satisfies NativeReadProof);
  return { readProofs, assistantMessages: finalAssistantText ? [finalAssistantText] : [] };
}

export function cursorUnsupportedRow(input: {
  usageEventCount: number;
  after: UsageTriad | null;
  rawTerminalResult: JsonRecord;
  identity: JsonRecord;
}): JsonRecord {
  if (input.usageEventCount !== 0 || input.after !== null) fail("Cursor ACP unexpectedly emitted or persisted token usage");
  const stopReason = identityText(input.rawTerminalResult.stopReason, "Cursor ACP projected stopReason");
  if (!(new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"])).has(stopReason)) {
    fail(`Cursor ACP projected stopReason is unsupported: ${stopReason}`);
  }
  return {
    schemaVersion: 1,
    status: "unsupported_by_active_transport",
    backend: "cursor",
    activeTransport: ACTIVE_TRANSPORT.cursor,
    providerModels: ["not_exposed_by_cursor_acp"],
    nativeSourceName: "cursor_acp_terminal_result",
    nativeRaw: { stopReason },
    alookDailyDelta: null,
    comparison: { exact: null, reason: "active transport exposes no settled usage" },
    ...input.identity,
  };
}

function validateSettlementBoundary(backend: Exclude<Backend, "cursor">, native: NativeTurn[], rawLines: string[]): void {
  if (backend === "claude") {
    const terminals = parseJsonRecords(rawLines.join("\n")).filter((record) => record.type === "result" && record.modelUsage);
    if (terminals.length !== 1 || count(terminals[0].num_turns, "Claude result.num_turns") < 2) {
      fail("Claude workload did not report a multi-settlement num_turns boundary");
    }
    return;
  }
  const records = native.reduce((total, turn) => add(total, turn.providerRecordIds.length, `${backend} settled record count`), 0);
  if (records < 2) fail(`${backend} workload produced fewer than two settled native records`);
}

async function runBackend(backend: Backend, outputPath: string): Promise<void> {
  const [{ createAgentDriverSdk }, { createDefaultAgentDriverHost }, { DailyTokenUsageStore }] = await Promise.all([
    import("../src/daemon/agent-driver/src/sdk.ts"),
    import("../src/daemon/agent-driver/src/host/default-host.ts"),
    import("../src/daemon/src/telemetry/dailyTokenUsage.ts"),
  ]);
  const root = await mkdtemp(join(tmpdir(), `alook-token-benchmark-${backend}-`));
  const launchId = `token-benchmark-${backend}-${Date.now()}`;
  let session: any;
  let eventTask: Promise<void> | undefined;
  let installedVersion: string | null = null;
  let backendSessionId: string | null = null;
  let terminalResult: JsonRecord | null = null;
  const rawLines: string[] = [];
  const stderrLines: string[] = [];
  const diagnostics: JsonRecord[] = [];
  const sessionFailures: JsonRecord[] = [];
  try {
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "package.json"), '{"name":"alook-token-benchmark","private":true}\n', "utf8");
    const botId = `benchmark-${backend}`;
    const store = new DailyTokenUsageStore(root);
    const sdk = createAgentDriverSdk({
      host: createDefaultAgentDriverHost({
        onRawOutput(event) {
          if (event.stream === "stdout") rawLines.push(event.text);
          else stderrLines.push(event.text);
        },
      }),
    });
    const probe = await sdk.probe({ backend } as any);
    if (probe.status !== "healthy" || typeof probe.version !== "string" || !probe.version) {
      fail(`${backend} installed runtime version is unavailable`);
    }
    installedVersion = probe.version;
    const opened = await sdk.open({
      backend,
      launch: {
        workingDirectory: cwd,
        launchId,
        instructions: { format: "markdown", content: "Token benchmark. Never edit files. Use read-only tools only." },
      },
      config: backendConfig(backend),
    } as any);
    if (!opened.ok) fail(`${backend} session failed to open: ${opened.error.code}`);
    session = opened.session;
    const writePromises: Promise<void>[] = [];
    const usageEvents: unknown[] = [];
    const assistantMessages: string[] = [];
    const completed = new Map<string, (event: any) => void>();
    eventTask = (async () => {
      for await (const event of session.events) {
        if (event.type === "token_usage") {
          usageEvents.push(event);
          writePromises.push(store.record(botId, event.usage));
        }
        if (event.type === "assistant_message_completed") assistantMessages.push(event.text);
        if (event.type === "diagnostic") diagnostics.push({ severity: event.severity, source: event.source, message: redactText(event.message) });
        if (event.type === "session_failed") sessionFailures.push({ code: event.error.code, message: redactText(event.error.message) });
        if (event.type === "turn_completed") {
          for (const commandId of event.commandIds) completed.get(commandId)?.(event);
        }
      }
    })();
    const beforeWindow = await store.usageWindow(botId);
    const day = beforeWindow.usageDay;
    const before = usageForDay(beforeWindow.snapshots, day);
    const commandId = `${launchId}:turn:1`;
    const terminal = new Promise<any>((resolve, reject) => {
      completed.set(commandId, resolve);
      setTimeout(() => reject(new Error(`${backend} benchmark turn timed out`)), 10 * 60_000).unref();
    });
    const receipt = await session.start({
      id: commandId,
      kind: "user",
      text: "Mandatory benchmark action: call a read-only file-reading tool on the exact path ./package.json and wait for its result. Do not infer the file contents. After the tool succeeds, reply with exactly BENCHMARK_OK and nothing else.",
    });
    if (receipt.status !== "accepted") fail(`${backend} benchmark prompt was rejected: ${receipt.reason}`);
    const terminalEvent = await terminal;
    terminalResult = {
      turnId: terminalEvent.turnId,
      outcome: terminalEvent.result.outcome,
      ...(terminalEvent.result.error ? { error: { code: terminalEvent.result.error.code, message: redactText(terminalEvent.result.error.message) } } : {}),
    };
    if (terminalEvent.result.outcome !== "success") validateWorkload({
      terminalOutcome: terminalEvent.result.outcome,
      terminalErrorCode: terminalEvent.result.error?.code,
      assistantMessages,
      readProofs: [],
    });
    await Promise.all(writePromises);
    const afterWindow = await store.usageWindow(botId);
    if (afterWindow.usageDay !== day) fail("benchmark crossed the local calendar day");
    const after = usageForDay(afterWindow.snapshots, day);
    const sessionId = session.snapshot().backendSessionId;
    if (!sessionId) fail(`${backend} backend session identity is missing`);
    backendSessionId = sessionId;
    await session.stop({ reason: "owner_request", forceAfterMs: 5_000 });
    await eventTask;
    eventTask = undefined;

    let artifact: JsonRecord;
    if (backend === "cursor") {
      const records = parseJsonRecords(rawLines.join("\n"));
      const rawEvidence = extractCursorToolEvidence(records);
      validateWorkload({
        terminalOutcome: terminalEvent.result.outcome,
        terminalErrorCode: terminalEvent.result.error?.code,
        assistantMessages: [...assistantMessages, ...rawEvidence.assistantMessages],
        readProofs: rawEvidence.readProofs,
      });
      const rawTerminalResult = extractCursorTerminal(records);
      artifact = cursorUnsupportedRow({
        usageEventCount: usageEvents.length,
        after,
        rawTerminalResult,
        identity: {
        installedVersion: probe.version,
        configuredProvider: "cursor",
        configuredModel: "default",
        launchId,
        backendSessionId: sessionId,
        terminalTurnId: terminalEvent.turnId,
        workload: "read_package_json_then_benchmark_ok",
        workloadObserved: { packageJsonRead: true, exactMarker: true },
        alookDailyBefore: before,
        alookDailyAfter: after,
        },
      });
    } else {
      const evidence = await nativeEvidence(backend, rawLines, launchId, sessionId, cwd);
      const native = evidence.turns;
      validateWorkload({
        terminalOutcome: terminalEvent.result.outcome,
        terminalErrorCode: terminalEvent.result.error?.code,
        assistantMessages,
        readProofs: evidence.readProofs,
      });
      validateSettlementBoundary(backend, native, rawLines);
      const providerModels = [...new Set(native.flatMap((turn) => turn.providerModels))].sort();
      if (providerModels.length === 0) fail(`${backend} provider model identity is missing`);
      const nativeTotal = sumTriads(native.map((turn) => turn.usage));
      const alook = dailyDelta(before, after);
      artifact = {
        schemaVersion: 1,
        status: "measured",
        backend,
        installedVersion: probe.version,
        activeTransport: ACTIVE_TRANSPORT[backend],
        configuredProvider: backend === "claude" || backend === "pi" ? "default" : backend,
        configuredModel: "default",
        providerModels,
        launchId,
        backendSessionId: sessionId,
        terminalTurnId: terminalEvent.turnId,
        workload: "read_package_json_then_benchmark_ok",
        workloadObserved: { packageJsonRead: true, exactMarker: true },
        localDay: day,
        nativeTurns: native,
        nativeTotal,
        alookDailyBefore: before,
        alookDailyAfter: after,
        alookDailyDelta: alook,
        comparison: compareUsage(nativeTotal, alook),
      };
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ outputPath, status: artifact.status, comparison: artifact.comparison })}\n`);
  } catch (error) {
    backendSessionId ??= session?.snapshot?.().backendSessionId ?? null;
    const invalidArtifact = {
      schemaVersion: 1,
      status: "invalid",
      backend,
      installedVersion,
      activeTransport: ACTIVE_TRANSPORT[backend],
      configuredProvider: backend === "claude" || backend === "pi" ? "default" : backend,
      configuredModel: "default",
      launchId,
      backendSessionId,
      failure: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(error instanceof Error ? error.message : error),
      },
      terminalResult,
      diagnostics: diagnostics.slice(-40),
      sessionFailures: sessionFailures.slice(-10),
      stdoutTail: redactedOutputTail(rawLines),
      stderrTail: redactedStderrTail(stderrLines),
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(invalidArtifact, null, 2)}\n`, { mode: 0o600 });
    throw error;
  } finally {
    if (session) await session.stop({ reason: "owner_request", forceAfterMs: 5_000 }).catch(() => {});
    if (eventTask) await eventTask.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

function usage(): never {
  process.stderr.write("Usage: benchmark-token-usage.mts run <claude|codex|cursor|opencode|pi> <output.json>\n");
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, backendValue, outputValue] = process.argv.slice(2);
  if (command !== "run" || !backendValue || !outputValue) usage();
  if (!(["claude", "codex", "cursor", "opencode", "pi"] as string[]).includes(backendValue)) usage();
  await runBackend(backendValue as Backend, outputValue);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
