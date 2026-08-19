import { describe, expect, it, vi } from "vitest";
import { BufferedEventQueue } from "./event-queue.js";

describe("BufferedEventQueue", () => {
  it("preserves event boundaries and FIFO order", async () => {
    const queue = new BufferedEventQueue<Record<string, unknown>>(() => {}, () => {});
    queue.push({ type: "one", text: "a" });
    queue.push({ type: "two", text: "b" });
    queue.close();
    const observed: Array<Record<string, unknown>> = [];
    for await (const event of queue.stream) observed.push(event);
    expect(observed).toEqual([{ type: "one", text: "a" }, { type: "two", text: "b" }]);
  });

  it("rejects a second iterator", () => {
    const queue = new BufferedEventQueue(() => {}, () => {});
    queue.stream[Symbol.asyncIterator]();
    expect(() => queue.stream[Symbol.asyncIterator]()).toThrow("one consumer");
  });

  it("initiates consumer cleanup from iterator.return", async () => {
    const onClosed = vi.fn();
    const queue = new BufferedEventQueue(onClosed, () => {});
    const iterator = queue.stream[Symbol.asyncIterator]();
    await iterator.return?.();
    await iterator.return?.();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("fails closed on overflow while retaining the reserved terminal event", async () => {
    const overflow = vi.fn();
    const queue = new BufferedEventQueue<{ type: string; text: string }>(() => {}, overflow);
    expect(queue.push({ type: "oversized", text: "x".repeat(queue.stream.maxBufferedBytes) })).toBe(false);
    expect(overflow).toHaveBeenCalledOnce();
    expect(queue.push({ type: "another", text: "x" })).toBe(false);
    expect(overflow).toHaveBeenCalledOnce();
    expect(queue.push({ type: "session_closed", text: "terminal" }, true)).toBe(true);
    queue.close();
    const iterator = queue.stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { type: "session_closed", text: "terminal" } });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });
});
