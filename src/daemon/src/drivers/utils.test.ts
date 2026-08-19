import { describe, it, expect } from "vitest";
import { jsonRpcRequest, tryParseJsonLine } from "./utils";

describe("jsonRpcRequest", () => {
  it("produces a valid JSON-RPC 2.0 envelope with the given method and params", () => {
    const line = jsonRpcRequest("thread/start", { cwd: "/tmp" }, 7);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 7, method: "thread/start", params: { cwd: "/tmp" } });
  });

  it("mints a unique id when omitted", () => {
    const a = JSON.parse(jsonRpcRequest("m", {}));
    const b = JSON.parse(jsonRpcRequest("m", {}));
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });

  it("honours a caller-supplied id", () => {
    const parsed = JSON.parse(jsonRpcRequest("m", {}, "kept"));
    expect(parsed.id).toBe("kept");
  });
});

describe("tryParseJsonLine", () => {
  it("round-trips valid JSON", () => {
    expect(tryParseJsonLine('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null (no throw) for invalid JSON", () => {
    expect(tryParseJsonLine("not json")).toBeNull();
  });

  it("returns null for an empty line", () => {
    expect(tryParseJsonLine("")).toBeNull();
  });
});
