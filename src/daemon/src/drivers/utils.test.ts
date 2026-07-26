import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { jsonRpcRequest, tryParseJsonLine, writeToStdinAndDetach } from "./utils";

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

describe("writeToStdinAndDetach", () => {
  it("defers the write to a microtask and closes stdin exactly once after", async () => {
    const stdin = { write: vi.fn(), end: vi.fn() };
    const proc = Object.assign(new EventEmitter(), { stdin });
    writeToStdinAndDetach(proc as never, "hello");

    // Not written yet — microtask hasn't run.
    expect(stdin.write).not.toHaveBeenCalled();
    expect(stdin.end).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(stdin.write).toHaveBeenCalledTimes(1);
    expect(stdin.write).toHaveBeenCalledWith("hello");
    expect(stdin.end).toHaveBeenCalledTimes(1);
    // write is called before end within the same microtask flush.
    const writeOrder = stdin.write.mock.invocationCallOrder[0];
    const endOrder = stdin.end.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(endOrder);
  });
});
