import { afterAll, expect, it } from "vitest";
import { compilePiiSource, PiiRunner } from "./evaluator.js";
import { PII_DEFAULTS } from "./defaults.js";

const runner = new PiiRunner();
afterAll(async () => { await runner.close(); });
const node = (id: string, source: string) => ({ id, code: compilePiiSource(source) });

it("uses each explicit bool even if a later plugin restores the original text", async () => {
  const result = await runner.evaluateWithResult([
    node("first", 'export default () => ({ text: "changed", triggered: true });'),
    node("restore", 'export default () => ({ text: "original", triggered: false });'),
    node("same", 'export default (text: string) => ({ text, triggered: true });'),
  ], "original");
  expect(result).toEqual({ text: "original", triggers: [
    { pluginId: "first", triggered: true }, { pluginId: "restore", triggered: false }, { pluginId: "same", triggered: true },
  ] });
});

it("executes legacy string plugins with per-node compatibility estimates", async () => {
  expect(await runner.evaluateWithResult([
    node("legacy-first", 'export default () => "changed";'),
    node("legacy-restore", 'export default () => "original";'),
    node("legacy-same", 'export default (text: string) => text;'),
  ], "original")).toEqual({ text: "original", triggers: [
    { pluginId: "legacy-first", triggered: true, legacy: true },
    { pluginId: "legacy-restore", triggered: true, legacy: true },
    { pluginId: "legacy-same", triggered: false, legacy: true },
  ] });
});

it.each(['null', '[]', '{}', '({text: "x"})', '({triggered: true})', '({text: 1, triggered: true})', '({text: "x", triggered: "true"})', '({text: "x", triggered: 1})', 'Promise.resolve({text: "x", triggered: true})'])
  ("rejects malformed structured result %s without exposing raw text", async value => {
    const result = runner.evaluateWithResult([node("bad", `export default () => ${value};`)], "PRIVATE_INPUT");
    await expect(result).rejects.toMatchObject({ code: "PII_INVALID_RESULT", pluginId: "bad" });
    await expect(result).rejects.not.toThrow("PRIVATE_INPUT");
  });

it("does not expose partial trigger results or text when a later plugin throws", async () => {
  await expect(runner.evaluateWithResult([
    node("hit", 'export default () => ({text: "PRIVATE_INTERMEDIATE", triggered: true});'),
    node("fail", 'export default (text: string) => { throw new Error(text); };'),
  ], "PRIVATE_INPUT")).rejects.toMatchObject({ code: "PII_PLUGIN_FAILED", pluginId: "fail", message: "PII_PLUGIN_FAILED: fail" });
});

it("validates getters and bounded text inside the isolated runtime", async () => {
  await expect(runner.evaluateWithResult([node("getter", 'export default () => ({ get text(){ throw new Error("PRIVATE_INPUT"); }, triggered:true });')], ""))
    .rejects.toMatchObject({ code: "PII_PLUGIN_FAILED", pluginId: "getter" });
  await expect(runner.evaluateWithResult([node("expand", 'export default () => ({ text: "x".repeat(65537), triggered:true });')], ""))
    .rejects.toMatchObject({ code: "PII_OUTPUT_TOO_LARGE", pluginId: "expand" });
});

it.each(PII_DEFAULTS)("builtin $id explicitly reports no trigger for ordinary text", async plugin => {
  expect(await runner.evaluateWithResult([node(plugin.id, plugin.source)], "ordinary reference")).toEqual({ text: "ordinary reference", triggers: [{ pluginId: plugin.id, triggered: false }] });
});

it.each(["pk_live_", "pk_test_", "sk_live_", "sk_test_", "rk_live_", "rk_test_", "sb_publishable_", "sb_secret_", "whsec_"])
  ("redacts full synthetic %s values and reports the merged filter", async prefix => {
    const key = prefix + "Ab9x".repeat(25), plugin = PII_DEFAULTS[0];
    const nodes = [node(plugin.id, plugin.source)];
    expect(await runner.evaluateWithResult(nodes, `key: "${key}".`)).toEqual({ text: 'key: "[REDACTED_API_KEY]".', triggers: [{ pluginId: plugin.id, triggered: true }] });
    for (const text of [prefix + "short", "reference_" + key]) {
      expect(await runner.evaluateWithResult(nodes, text)).toEqual({ text, triggers: [{ pluginId: plugin.id, triggered: false }] });
    }
  });

it("retains recognized provider families alongside the expanded publishable/secret formats", async () => {
  const keys = [
    "sk-proj-" + "a".repeat(32), "sk-ant-" + "a".repeat(32), "sk-or-" + "a".repeat(32),
    "ghp_" + "a".repeat(36), "github_pat_" + "a".repeat(48), "glpat-" + "a".repeat(24),
    "AIza" + "a".repeat(35), "xoxb-" + "a".repeat(24), "AKIA" + "A1".repeat(8),
    "hf_" + "a".repeat(32), "gsk_" + "a".repeat(48), "xai-" + "a".repeat(48),
    "npm_" + "a".repeat(36), "pypi-" + "a".repeat(54), "dop_v1_" + "a".repeat(64),
    "SG." + "a".repeat(22) + "." + "b".repeat(43), "cmk_" + "a".repeat(24),
    "pk_test_" + "ZXhhbXBsZS5hY2NvdW50cy5kZXYk", "pk_live_" + "aB1+/".repeat(8) + "==",
  ];
  const plugin = PII_DEFAULTS[0];
  for (const key of keys) expect(await runner.evaluateWithResult([node(plugin.id, plugin.source)], key)).toEqual({ text: "[REDACTED_API_KEY]", triggers: [{ pluginId: plugin.id, triggered: true }] });
});
