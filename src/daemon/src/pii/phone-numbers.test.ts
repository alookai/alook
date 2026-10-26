import { afterAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PII_DEFAULTS } from "./defaults.js";
import { PHONE_NUMBERS_SOURCE } from "./phone-numbers.js";
import { compilePiiSource, PiiRunner } from "./evaluator.js";

const runner = new PiiRunner();
afterAll(async () => { await runner.close(); });
const phone = { id: "builtin.phones", code: compilePiiSource(PHONE_NUMBERS_SOURCE) };
const apply = (text: string) => runner.evaluateWithResult([phone], text);
const examples = JSON.parse(readFileSync(new URL("./fixtures/phone-examples.json", import.meta.url), "utf8")) as {region: string; callingCode: string; national: string; prefix: string}[];

it("fits the existing plugin source limit", () => {
  expect(Buffer.byteLength(PHONE_NUMBERS_SOURCE)).toBeLessThanOrEqual(16 * 1024);
});

it("recognizes the pinned upstream examples for every supported numbering plan", async () => {
  for (const example of examples) {
    const input = "+" + example.callingCode + example.national;
    expect(await apply(input), example.region + "/" + example.callingCode).toEqual({text: "[REDACTED_PHONE]", triggers: [{pluginId: phone.id, triggered: true}]});
  }
}, 15000);

it.each([
  ["+1 (202) 555-0123", "[REDACTED_PHONE]"],
  ["+44 20 7946 0018", "[REDACTED_PHONE]"],
  ["+49 (0)30 123456", "[REDACTED_PHONE]"],
  ["+33 1 42 68 53 00", "[REDACTED_PHONE]"],
  ["+91 81234 56789", "[REDACTED_PHONE]"],
  ["+81 3-1234-5678", "[REDACTED_PHONE]"],
  ["+82 2-2123-4567", "[REDACTED_PHONE]"],
  ["+61 2 1234 5678", "[REDACTED_PHONE]"],
  ["+55 11 91234-5678", "[REDACTED_PHONE]"],
  ["＋852 2123 4567", "[REDACTED_PHONE]"],
  ["Phone: 020 7946 0018", "Phone: [REDACTED_PHONE]"],
  ['"phone_number": "03-1234-5678"', '"phone_number": "[REDACTED_PHONE]"'],
  ["Téléphone: 01 42 68 53 00", "Téléphone: [REDACTED_PHONE]"],
  ["電話: 03-1234-5678", "電話: [REDACTED_PHONE]"],
  ["전화: 02-2123-4567", "전화: [REDACTED_PHONE]"],
  ["tel=0044 20 7946 0018", "tel=[REDACTED_PHONE]"],
  ["mobile: (020) 7946 0018", "mobile: [REDACTED_PHONE]"],
  ["(202) 555-0123", "[REDACTED_PHONE]"],
  ["202.555.0123", "[REDACTED_PHONE]"],
  ["13800138000", "[REDACTED_PHONE]"],
  ["8613800138000", "[REDACTED_PHONE]"],
])("filters %s with an explicit hit", async (input, output) => {
  expect((await apply(input)).text).toBe(output);
  expect((await apply(input)).triggers).toEqual([{pluginId:phone.id,triggered:true}]);
});

it.each([
  "order: 2025550123", "2024-10-26", "version 1.2.3", "SSN: 219-09-9999", "invoice: 02079460018",
  "https://example.test/+12025550123", "file/+442079460018.txt", "prefix+12025550123suffix", "foo_phone: 2025550123",
  "+999 123456789", "+1 123 456 7890", "+1 2025550123456789", "+44 2079 4600 1812 3456 7890", "Phone: 123", "Phone: 12345678901234567890",
  "550e8400-e29b-41d4-a716-138001380000", "a13800138000b123456789012345678901234567890", "plain 219099999 and 2025550123",
])("preserves nonphone or ambiguous input %s", async input => {
  expect(await apply(input)).toEqual({text:input,triggers:[{pluginId:phone.id,triggered:false}]});
});

it("keeps ordinary references through the full default pipeline and reports only Phone numbers", async () => {
  const plugins=PII_DEFAULTS.map(plugin=>({id:plugin.id,code:compilePiiSource(plugin.source)}));
  const result=await runner.evaluateWithResult(plugins,"Call +44 20 7946 0018; order 2025550123; date 2024-10-26");
  expect(result.text).toBe("Call [REDACTED_PHONE]; order 2025550123; date 2024-10-26");
  expect(result.triggers.filter(trigger=>trigger.triggered)).toEqual([{pluginId:phone.id,triggered:true}]);
  expect((await runner.evaluateWithResult(plugins,result.text)).text).toBe(result.text);
});

it("handles maximum ordinary input inside the unchanged sandbox deadline", async () => {
  expect((await apply(" ".repeat(65536))).text).toHaveLength(65536);
});
