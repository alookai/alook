import { describe, expect, it } from "vitest";
import { Utf8LineFramer, Utf8TextDecoder } from "./utf8-lines.js";

describe("raw UTF-8 stream framing", () => {
  it("counts undecoded scalar bytes at the aggregate cap and resets after overflow", () => {
    const frames = new Utf8LineFramer(4);
    expect(frames.write(Buffer.from([0x61, 0x62, 0x63, 0xf0]))).toEqual([]);
    expect(frames.pendingByteLength).toBe(4);
    expect(() => frames.write(Buffer.from([0x9f]))).toThrow("byte limit");
    expect(frames.pendingByteLength).toBe(0);
    expect(frames.write("x\n")).toEqual(["x"]);
  });
  it.each([1, 2, 3])("keeps %s raw tail bytes after a newline without counting decoded characters", held => {
    const frames = new Utf8LineFramer();
    const scalar = Buffer.from("😀");
    expect(frames.write(Buffer.concat([Buffer.from("ready\n"), scalar.subarray(0, held)]))).toEqual(["ready"]);
    expect(frames.pendingByteLength).toBe(held);
    expect(frames.write(Buffer.concat([scalar.subarray(held), Buffer.from("\n")]))).toEqual(["😀"]);
    expect(frames.pendingByteLength).toBe(0);
  });
  it("keeps independent stream decoders and flushes an incomplete scalar on end", () => {
    const stdout = new Utf8TextDecoder(), stderr = new Utf8TextDecoder();
    const output = Buffer.from("€😀"), error = Buffer.from("₿₩");
    expect(stdout.write(output.subarray(0, 2))).toBe("");
    expect(stderr.write(error)).toBe("₿₩");
    expect(stdout.write(output.subarray(2))).toBe("€😀");
    expect(stderr.write(Buffer.from([0xf0, 0x9f]))).toBe("");
    expect(stderr.end()).toBe("�");
    expect(stdout.end()).toBe("");
  });
});
