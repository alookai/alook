import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiiStore } from "./store.js";
import { compilePiiSource, evaluatePii, PiiRunner } from "./evaluator.js";
import { PII_DEFAULTS } from "./defaults.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});
vi.mock("./evaluator.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./evaluator.js")>();
  return { ...original, compilePiiSource: vi.fn(original.compilePiiSource) };
});

const directories: string[] = [];
const stores: PiiStore[] = [];
const storeAt = (path: string) => { const store = new PiiStore(path); stores.push(store); return store; };
const create = () => {
  const directory = mkdtempSync(join(tmpdir(), "pii-test-"));
  directories.push(directory);
  const path = join(directory, "machine");
  return { store: storeAt(path), path };
};
const fileFor = (path: string, botId = "a") => join(path, botId, "pii", "pipelines.json");
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe("PII pipeline", () => {
  it("composes TS modules in order, isolates bots, skips disabled nodes and retains explicit deletion", async () => {
    const { store, path } = create();
    let snapshot = store.list("a");
    for (const plugin of snapshot.plugins) {
      const result = await store.manage("a", { action: "remove", pluginId: plugin.id, expectedRevision: snapshot.revision });
      if (result.status !== "complete") throw new Error("remove failed");
      snapshot = result.snapshot;
    }
    expect(storeAt(path).list("a").plugins).toEqual([]);
    expect(store.list("b").plugins).toHaveLength(5);
    snapshot = await store.local("a", { action: "add", name: "first", description: "replace seed", source: 'export default (text: string): string => text.replace("seed", "middle");' });
    snapshot = await store.local("a", { action: "add", name: "second", description: "replace middle", source: 'export default function(text: string): string { return text.replace("middle", "done"); }' });
    expect(await store.filter("a", "seed")).toBe("done");
    expect(await store.filter("b", "seed")).toBe("seed");
    expect(await store.manage("a", { action: "setEnabled", pluginId: snapshot.plugins[0]!.id, enabled: false, expectedRevision: snapshot.revision - 1 })).toMatchObject({ status: "error", code: "PII_CONFLICT", snapshot });
    expect(await store.manage("a", { action: "setEnabled", pluginId: snapshot.plugins[0]!.id, enabled: false, expectedRevision: snapshot.revision })).toMatchObject({ status: "complete" });
    expect(await storeAt(path).filter("a", "seed")).toBe("seed");
    expect(readFileSync(fileFor(path), "utf8")).toContain("export default");
    expect(snapshot.plugins[0]).not.toHaveProperty("source");
  });

  it("does not lose concurrent additions and does not accept invalid plugins", async () => {
    const { store } = create();
    const input = { action: "add" as const, name: "extra", description: "identity", source: 'export default (text: string) => text;' };
    await Promise.all([store.local("a", input), store.local("a", input)]);
    const snapshot = store.list("a");
    expect(snapshot.plugins).toHaveLength(7);
    expect(new Set(snapshot.plugins.map((plugin) => plugin.id)).size).toBe(7);
    for (const source of ['export default () => 1;', 'export default async () => "x";', 'export default () => process.env;', 'import fs from "node:fs"; export default () => fs.readFileSync("x");']) {
      await expect(store.local("a", { ...input, source })).rejects.toThrow(/^PII_/);
    }
    expect(store.list("a")).toEqual(snapshot);
  });

  it("previews the same ordered runner at a captured revision without persisting input, output or defaults", async () => {
    const { store, path } = create();
    const file = fileFor(path);
    expect(existsSync(path)).toBe(false);
    expect(await store.manage("a", { action: "preview", text: "person@company.cn", expectedRevision: 0 }))
      .toMatchObject({ status: "complete", output: "[REDACTED_EMAIL]", snapshot: { revision: 0 } });
    expect(existsSync(path)).toBe(false);
    const snapshot = await store.local("a", { action: "add", name: "last", description: "transform previous output", source: 'export default (text: string) => text.replace("[REDACTED_EMAIL]", "[FINAL]");' });
    const before = readFileSync(file, "utf8");
    const pending = store.manage("a", { action: "preview", text: "person@company.cn", expectedRevision: snapshot.revision });
    const changed = await store.manage("a", { action: "setEnabled", pluginId: "builtin.emails", enabled: false, expectedRevision: snapshot.revision });
    expect(changed.status).toBe("complete");
    expect(await pending).toEqual({ status: "complete", output: "[FINAL]", snapshot, triggeredFilters: snapshot.plugins.filter(p => p.id === "builtin.emails" || p.name === "last").map(({id, name}) => ({id, name})) });
    expect(await store.manage("a", { action: "preview", text: "person@company.cn", expectedRevision: snapshot.revision }))
      .toMatchObject({ status: "error", code: "PII_CONFLICT", snapshot: { revision: snapshot.revision + 1 } });
    const after = readFileSync(file, "utf8");
    expect(after).not.toBe(before);
    expect(after).not.toContain("person@company.cn");
    expect(await store.manage("a", { action: "preview", text: "person@company.cn", expectedRevision: snapshot.revision + 1 }))
      .toMatchObject({ status: "complete", output: "person@company.cn", triggeredFilters: [] });
    expect(readFileSync(file, "utf8")).toBe(after);
  });

  it("previews empty chains and returns bounded safe failures with no state writes", async () => {
    const { store, path } = create();
    let snapshot = store.list("a");
    for (const plugin of snapshot.plugins) {
      const result = await store.manage("a", { action: "remove", pluginId: plugin.id, expectedRevision: snapshot.revision });
      if (result.status !== "complete") throw new Error("remove failed");
      snapshot = result.snapshot;
    }
    expect(await store.manage("a", { action: "preview", text: "unchanged", expectedRevision: snapshot.revision }))
      .toEqual({ status: "complete", output: "unchanged", snapshot, triggeredFilters: [] });
    snapshot = await store.local("a", { action: "add", name: "fixture", description: "safe error fixtures", source: 'export default (text: string) => { if(!text)return text; if(text==="expand")return "中".repeat(400); if(text==="erase")return ""; if(text==="loop"){while(true){}} if(text==="number")return 1; throw new Error(text); };' });
    const before = readFileSync(fileFor(path), "utf8");
    for (const [text, code] of [["expand", "PII_OUTPUT_TOO_LARGE"], ["erase", "PII_INVALID_RESULT"], ["number", "PII_INVALID_RESULT"], ["loop", "PII_PLUGIN_FAILED"], ["private-error-text", "PII_PLUGIN_FAILED"]]) {
      const result = await store.manage("a", { action: "preview", text: text!, expectedRevision: snapshot.revision });
      expect(result).toMatchObject({ status: "error", code });
      expect(result).not.toHaveProperty("output");
      expect(JSON.stringify(result)).not.toContain(text);
    }
    expect(await store.manage("a", { action: "preview", text: "中".repeat(400), expectedRevision: snapshot.revision }))
      .toEqual({ status: "error", code: "PII_INVALID_REQUEST" });
    expect(readFileSync(fileFor(path), "utf8")).toBe(before);
  });

  it("fails closed on corrupt and missing established config", async () => {
    const { store, path } = create();
    store.list("a");
    writeFileSync(fileFor(path), "invalid");
    await expect(storeAt(path).filter("a", "private input")).rejects.toThrow("PII_CONFIG_UNAVAILABLE");
    expect(await storeAt(path).manage("a", { action: "list" })).toEqual({ status: "error", code: "PII_UNAVAILABLE" });
    rmSync(fileFor(path));
    expect(() => storeAt(path).list("a")).toThrow("PII_CONFIG_UNAVAILABLE");
  });

  it("reads and writes only the selected bot file, even when another bot file is corrupt or missing", async () => {
    const { store, path } = create();
    const a = store.list("a");
    const b = store.list("b");
    const bFile = fileFor(path, "b");
    const bBytes = readFileSync(bFile, "utf8");
    const added = await store.local("a", { action: "add", name: "a-only", description: "only A", source: 'export default (text: string) => text.replace("ALPHA_ONLY", "A_FILTERED");' });
    expect(added.revision).toBe(a.revision + 1);
    expect(readFileSync(bFile, "utf8")).toBe(bBytes);
    expect(store.list("b")).toEqual(b);
    expect(JSON.parse(readFileSync(fileFor(path), "utf8"))).toMatchObject({ version: 1, revision: 1 });
    expect(JSON.parse(bBytes)).not.toHaveProperty("bots");
    expect(bBytes).not.toContain("ALPHA_ONLY");
    expect(existsSync(join(path, "pii", "pipelines.json"))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(fileFor(path)).mode & 0o777).toBe(0o600);
      expect(statSync(join(path, "a", "pii")).mode & 0o777).toBe(0o700);
    }
    writeFileSync(bFile, "corrupt B");
    expect(await storeAt(path).filter("a", "ALPHA_ONLY")).toBe("A_FILTERED");
    await expect(storeAt(path).filter("b", "ALPHA_ONLY")).rejects.toThrow("PII_CONFIG_UNAVAILABLE");
    rmSync(bFile);
    expect(await storeAt(path).filter("a", "ALPHA_ONLY")).toBe("A_FILTERED");
    expect(() => storeAt(path).list("b")).toThrow("PII_CONFIG_UNAVAILABLE");
    writeFileSync(bFile, bBytes);
    writeFileSync(fileFor(path), "corrupt A");
    expect(await storeAt(path).filter("b", "ALPHA_ONLY")).toBe("ALPHA_ONLY");
  });

  it("keeps the same bot isolated across daemon roots and rejects unsafe path segments before touching disk", async () => {
    const first = create();
    const second = create();
    const defaults = second.store.list("a");
    await first.store.local("a", { action: "add", name: "first", description: "first daemon only", source: 'export default (text: string) => text.replace("seed", "first");' });
    expect(await first.store.filter("a", "seed")).toBe("first");
    expect(await second.store.filter("a", "seed")).toBe("seed");
    expect(second.store.list("a")).toEqual(defaults);
    const fresh = create();
    const parentBefore = readdirSync(join(fresh.path, ".."));
    for (const id of ["", ".", "..", "../a", "a/b", "a\\b", "/tmp/a", "a".repeat(129), "a\0b"]) {
      expect(() => fresh.store.list(id)).toThrow("PII_INVALID_REQUEST");
      await expect(fresh.store.local(id, { action: "add", name: "safe", description: "identity", source: 'export default (text: string) => text;' })).rejects.toThrow("PII_INVALID_REQUEST");
    }
    expect(existsSync(fresh.path)).toBe(false);
    expect(readdirSync(join(fresh.path, ".."))).toEqual(parentBefore);
  });

  it("reuses loaded configuration and compiled filters without disk reads or compilation on repeated sends", async () => {
    const { store, path } = create();
    store.list("a");
    const restarted = storeAt(path);
    expect(await restarted.filter("a", "person@company.cn")).toBe("[REDACTED_EMAIL]");
    const reads = vi.mocked(readFileSync).mock.calls.length;
    const compilations = vi.mocked(compilePiiSource).mock.calls.length;
    for (let i = 0; i < 3; i++) expect(await restarted.filter("a", "person@company.cn")).toBe("[REDACTED_EMAIL]");
    expect(vi.mocked(readFileSync).mock.calls).toHaveLength(reads);
    expect(vi.mocked(compilePiiSource).mock.calls).toHaveLength(compilations);
    const changed = await restarted.manage("a", { action: "setEnabled", pluginId: "builtin.emails", enabled: false, expectedRevision: 0 });
    expect(changed.status).toBe("complete");
    expect(await restarted.filter("a", "person@company.cn")).toBe("person@company.cn");
    const afterChange = vi.mocked(compilePiiSource).mock.calls.length;
    expect(await restarted.filter("a", "person@company.cn")).toBe("person@company.cn");
    expect(vi.mocked(compilePiiSource).mock.calls).toHaveLength(afterChange);
    expect(vi.mocked(readFileSync).mock.calls).toHaveLength(reads);
    expect(await storeAt(path).filter("a", "person@company.cn")).toBe("person@company.cn");
  });

  it("publishes a new memory snapshot only after persistence succeeds", async () => {
    const { store, path } = create();
    const before = store.list("a");
    const file = fileFor(path);
    const persisted = readFileSync(file, "utf8");
    rmSync(file);
    mkdirSync(file);
    expect(await store.manage("a", { action: "setEnabled", pluginId: "builtin.emails", enabled: false, expectedRevision: before.revision }))
      .toEqual({ status: "error", code: "PII_UNAVAILABLE" });
    await expect(store.local("a", { action: "add", name: "unpersisted", description: "must not apply", source: 'export default (text: string) => text + "CHANGED";' })).rejects.toThrow("PII_CONFIG_UNAVAILABLE");
    expect(store.list("a")).toEqual(before);
    expect(await store.filter("a", "person@company.cn")).toBe("[REDACTED_EMAIL]");
    await expect(storeAt(path).filter("a", "person@company.cn")).rejects.toThrow("PII_CONFIG_UNAVAILABLE");
    rmSync(file, { recursive: true });
    writeFileSync(file, persisted);
    expect(storeAt(path).list("a")).toEqual(before);
  });

  it("reuses only the engine, isolates globals, serializes jobs and recovers queued work after failure", async () => {
    const runner = new PiiRunner();
    const node = (source: string) => [{ id: "fixture", code: compilePiiSource(source) }];
    const isolated = node('export default (text: string) => { globalThis.marker = (globalThis.marker || 0) + 1; return text + globalThis.marker; };');
    try {
      expect(await runner.evaluate(isolated, "a")).toBe("a1");
      expect(await runner.evaluate(isolated, "b")).toBe("b1");
      const failed = runner.evaluate(node('export default (text: string) => /^(a+)+$/.test(text) ? text : "no";'), "a".repeat(100) + "!");
      const queued = runner.evaluate(isolated, "queued");
      await expect(failed).rejects.toThrow(/^PII_/);
      expect(await queued).toBe("queued1");
      expect(await Promise.all([runner.evaluate(isolated, "first"), runner.evaluate(isolated, "second")])).toEqual(["first1", "second1"]);
    } finally { await runner.close(); }
    await expect(runner.evaluate(isolated, "stopped")).rejects.toThrow("PII_UNAVAILABLE");
  });

  it("bounds waiting jobs and queue time when slow plugins contend", async () => {
    const runner = new PiiRunner();
    const plugins = [{ id: "slow", code: compilePiiSource('export default () => { while(true) {} };') }];
    const started = Date.now();
    try {
      const results = await Promise.allSettled(Array.from({ length: 34 }, () => runner.evaluate(plugins, "PRIVATE_QUEUE")));
      expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "PII_PLUGIN_FAILED" } });
      expect(results[31]).toMatchObject({ status: "rejected", reason: { code: "PII_UNAVAILABLE" } });
      expect(results[33]).toMatchObject({ status: "rejected", reason: { code: "PII_UNAVAILABLE" } });
      expect(Date.now() - started).toBeLessThan(4_500);
      expect(JSON.stringify(results)).not.toContain("PRIVATE_QUEUE");
      expect(await runner.evaluate([{ id: "ok", code: compilePiiSource('export default (text: string) => text;') }], "recovered")).toBe("recovered");
    } finally { await runner.close(); }
  });

  it("closes active and queued evaluations without leaving worker work running", async () => {
    const runner = new PiiRunner();
    const plugins = [{ id: "loop", code: compilePiiSource('export default () => { while(true) {} };') }];
    const active = runner.evaluate(plugins, "");
    const queued = runner.evaluate(plugins, "");
    const results = Promise.allSettled([active, queued]);
    await new Promise(resolve => setTimeout(resolve, 20));
    await runner.close();
    expect((await results).map(result => result.status)).toEqual(["rejected", "rejected"]);
  });

  it("bounds infinite loops, complex regular expressions and allocations without exposing raw exceptions", async () => {
    const sources = [
      'export default () => { while(true) {} };',
      'export default (text: string) => /^(a+)+$/.test(text) ? text : "no";',
      'export default () => "x".repeat(100000000);',
      'export default (text: string) => { throw new Error(text); };',
    ];
    for (const source of sources) {
      const started = Date.now();
      await expect(evaluatePii([{ id: "bounded", code: compilePiiSource(source) }], "a".repeat(100) + "!PRIVATE")).rejects.toThrow(/^PII_/);
      expect(Date.now() - started).toBeLessThan(4_000);
    }
    expect(await evaluatePii([{ id: "host", code: compilePiiSource('export default () => [typeof process,typeof require,typeof fetch,typeof Bun,typeof console].join(",");') }], "")).toBe("undefined,undefined,undefined,undefined,undefined");
  });
});

describe("PII configuration recovery", () => {
  it("keeps missing-filter removal idempotent and refuses to enable a missing filter", async () => {
    const { store, path } = create();
    const snapshot = store.list("a");
    const before = readFileSync(fileFor(path), "utf8");
    expect(await store.manage("a", { action: "remove", pluginId: "missing", expectedRevision: snapshot.revision }))
      .toEqual({ status: "complete", snapshot });
    expect(await store.manage("a", { action: "setEnabled", pluginId: "missing", enabled: true, expectedRevision: snapshot.revision }))
      .toEqual({ status: "error", code: "PII_PLUGIN_NOT_FOUND" });
    expect(readFileSync(fileFor(path), "utf8")).toBe(before);
  });

  it("blocks installed source corruption without leaking the sample or replacing the stored rules", async () => {
    const { store, path } = create();
    const snapshot = store.list("a");
    const file = fileFor(path);
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    persisted.plugins[0].source = "export default (";
    const bytes = JSON.stringify(persisted);
    writeFileSync(file, bytes);
    const restarted = storeAt(path);
    await expect(restarted.filter("a", "PRIVATE_SAMPLE")).rejects.toMatchObject({ code: "PII_INVALID_SOURCE", pluginId: snapshot.plugins[0]!.id });
    const result = await restarted.manage("a", { action: "preview", text: "PRIVATE_SAMPLE", expectedRevision: snapshot.revision });
    expect(result).toEqual({ status: "error", code: "PII_INVALID_SOURCE", pluginId: snapshot.plugins[0]!.id });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SAMPLE");
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });
});

describe("default filter categories", () => {
  it("redacts email before sentence punctuation without taking the punctuation or matching filenames", async () => {
    const { store } = create();
    for (const punctuation of [".", "...", ".\nNext sentence", ",", "。", "，", ";", "!", "?"]) {
      expect(await store.filter("a", `Email me at lin@example.com${punctuation}`)).toBe(`Email me at [REDACTED_EMAIL]${punctuation}`);
    }
    expect(await store.filter("a", "image@2x.png. Notes follow.")).toBe("image@2x.png. Notes follow.");
  });
  const fixtures = [
    ["builtin.secrets", "before -----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY----- after", "before [REDACTED_PRIVATE_KEY] after", "a public key"],
    ["builtin.secrets", `key sk-${"a".repeat(24)}`, "key [REDACTED_API_KEY]", "sk-short"],
    ["builtin.secrets", "Authorization: Bearer synthetic-token", "Authorization: Bearer [REDACTED_TOKEN]", "a bearer of news"],
    ["builtin.secrets", 'DB_PASSWORD="aB12345678" postgres://u:pass1234@host/db', 'DB_PASSWORD="[REDACTED_SECRET]" postgres://u:[REDACTED_PASSWORD]@host/db', "token_id=abc123456789 process.env.ACCESS_TOKEN"],
    ["builtin.emails", "mail person@company.cn please", "mail [REDACTED_EMAIL] please", "@gus#1813 image@2x.png"],
    ["builtin.id-cards", "id 11010519491231002X", "id [REDACTED_ID_CARD]", "id 110105194912310021"],
    ["builtin.phones", "call +86 13800138000", "call [REDACTED_PHONE]", "prefix13800138000suffix"],
    ["builtin.bank-cards", "card 4111 1111 1111 1111", "card [REDACTED_BANK_CARD]", "4111 1111 1111 1112"],
  ];
  it.each(fixtures)("%s preserves surrounding and unrelated text", async (id, input, output, negative) => {
    const definition = PII_DEFAULTS.find((plugin) => plugin.id === id)!;
    const plugins = [{ id: definition.id, code: compilePiiSource(definition.source) }];
    expect(await evaluatePii(plugins, input!)).toBe(output);
    expect(await evaluatePii(plugins, negative!)).toBe(negative);
  });
  it("is idempotent and preserves UUIDs across nodes", async () => {
    const { store } = create();
    const input = "person@company.cn +86 13800138000 aaaa4111-1111-1111-9007-123456789012";
    const once = await store.filter("a", input);
    expect(once).toContain("aaaa4111-1111-1111-9007-123456789012");
    expect(await store.filter("a", once)).toBe(once);
  });
});

it("reports preview matches even when a later filter restores the original text", async () => {
  const { store } = create();
  await store.local("a", { action: "add", name: "first", description: "first change", source: 'export default (text: string) => text.replace("seed", "middle");' });
  const snapshot = await store.local("a", { action: "add", name: "second", description: "restore", source: 'export default (text: string) => text.replace("middle", "seed");' });
  const expected = snapshot.plugins.filter(plugin => plugin.name === "first" || plugin.name === "second").map(({ id, name }) => ({ id, name }));
  expect(await store.manage("a", { action: "preview", text: "seed", expectedRevision: snapshot.revision }))
    .toMatchObject({ status: "complete", output: "seed", triggeredFilters: expected });
  expect(await store.filterWithResult("a", "seed")).toEqual({ text: "seed", triggeredFilters: expected });
  expect(await store.manage("a", { action: "preview", text: "ordinary", expectedRevision: snapshot.revision }))
    .toMatchObject({ status: "complete", output: "ordinary", triggeredFilters: [] });
});
