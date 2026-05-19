import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskMessageStore } from "./task-message-store";
import type { TaskMessage } from "@alook/shared";

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: any) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

function createMockR2() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => {
      const val = store.get(key);
      if (!val) return null;
      return { text: async () => val } as unknown as R2ObjectBody;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    _store: store,
  } as unknown as R2Bucket & { _store: Map<string, string> };
}

const msg1: TaskMessage = {
  id: "m1", task_id: "t1", seq: 1, type: "tool-call",
  tool: "Read", call_id: "c1", content: "reading file",
  input: { file_path: "/foo.ts" }, output: "file contents here",
};

const msg2: TaskMessage = {
  id: "m2", task_id: "t1", seq: 2, type: "tool-result",
  tool: "Read", call_id: "c1", content: "", output: "result data",
};

const msg3: TaskMessage = {
  id: "m3", task_id: "t1", seq: 3, type: "tool-call",
  tool: "Edit", call_id: "c2", content: "editing file",
  input: { file_path: "/bar.ts" }, output: "done",
};

const msg4: TaskMessage = {
  id: "m4", task_id: "t1", seq: 4, type: "status",
  tool: "", call_id: "", content: "working...", output: "",
};

const msg5: TaskMessage = {
  id: "m5", task_id: "t1", seq: 5, type: "text",
  tool: "", call_id: "", content: "Here is the result", output: "",
};

describe("TaskMessageStore", () => {
  let kv: ReturnType<typeof createMockKV>;
  let r2: ReturnType<typeof createMockR2>;
  let store: TaskMessageStore;

  beforeEach(() => {
    kv = createMockKV();
    r2 = createMockR2();
    store = new TaskMessageStore(r2, kv);
  });

  describe("appendMessages", () => {
    it("writes to R2 and KV on first append", async () => {
      await store.appendMessages("t1", [msg1]);

      expect(r2.put).toHaveBeenCalledWith(
        "task-messages/t1.json",
        JSON.stringify([msg1]),
        { httpMetadata: { contentType: "application/json" } },
      );
      expect(kv.put).toHaveBeenCalledWith(
        "tm:t1",
        JSON.stringify([msg1]),
        { expirationTtl: 604800 },
      );
    });

    it("appends to existing messages from KV cache", async () => {
      kv._store.set("tm:t1", JSON.stringify([msg1]));

      await store.appendMessages("t1", [msg3]);

      const stored = JSON.parse(r2._store.get("task-messages/t1.json")!);
      expect(stored).toHaveLength(2);
      expect(stored[0].id).toBe("m1");
      expect(stored[1].id).toBe("m3");
    });

    it("falls back to R2 when KV has no cache", async () => {
      r2._store.set("task-messages/t1.json", JSON.stringify([msg1]));

      await store.appendMessages("t1", [msg3]);

      const stored = JSON.parse(r2._store.get("task-messages/t1.json")!);
      expect(stored).toHaveLength(2);
      expect(stored[0].id).toBe("m1");
      expect(stored[1].id).toBe("m3");
    });

    it("does nothing when messages array is empty", async () => {
      await store.appendMessages("t1", []);

      expect(r2.put).not.toHaveBeenCalled();
      expect(kv.put).not.toHaveBeenCalled();
    });

    it("appends multiple messages at once", async () => {
      await store.appendMessages("t1", [msg1, msg2, msg3]);

      const stored = JSON.parse(r2._store.get("task-messages/t1.json")!);
      expect(stored).toHaveLength(3);
      expect(stored.map((m: TaskMessage) => m.seq)).toEqual([1, 2, 3]);
    });

    it("handles KV write failure gracefully", async () => {
      (kv.put as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("KV down"));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await store.appendMessages("t1", [msg1]);

      // R2 write should still succeed
      expect(r2._store.has("task-messages/t1.json")).toBe(true);
      logSpy.mockRestore();
    });
  });

  describe("listMessages", () => {
    it("returns from KV on cache hit", async () => {
      kv._store.set("tm:t1", JSON.stringify([msg1, msg2, msg3]));

      const result = await store.listMessages("t1");

      expect(result).toHaveLength(3);
      expect(r2.get).not.toHaveBeenCalled();
    });

    it("falls back to R2 and populates KV on cache miss", async () => {
      r2._store.set("task-messages/t1.json", JSON.stringify([msg1, msg3]));

      const result = await store.listMessages("t1");

      expect(result).toHaveLength(2);
      expect(kv.put).toHaveBeenCalledWith(
        "tm:t1",
        JSON.stringify([msg1, msg3]),
        { expirationTtl: 604800 },
      );
    });

    it("returns empty array when neither KV nor R2 has data", async () => {
      const result = await store.listMessages("t1");
      expect(result).toEqual([]);
    });

    it("filters by since parameter (exclusive)", async () => {
      kv._store.set("tm:t1", JSON.stringify([msg1, msg2, msg3, msg4, msg5]));

      const result = await store.listMessages("t1", { since: 2 });

      expect(result).toHaveLength(3);
      expect(result[0].seq).toBe(3);
      expect(result[1].seq).toBe(4);
      expect(result[2].seq).toBe(5);
    });

    it("filters by excludeTypes", async () => {
      kv._store.set("tm:t1", JSON.stringify([msg1, msg2, msg3, msg4, msg5]));

      const result = await store.listMessages("t1", { excludeTypes: ["tool-result"] });

      expect(result).toHaveLength(4);
      expect(result.every((m) => m.type !== "tool-result")).toBe(true);
    });

    it("filters by multiple excludeTypes", async () => {
      kv._store.set("tm:t1", JSON.stringify([msg1, msg2, msg3, msg4, msg5]));

      const result = await store.listMessages("t1", { excludeTypes: ["tool-result", "status", "text"] });

      expect(result).toHaveLength(2);
      expect(result.every((m) => m.type === "tool-call")).toBe(true);
    });

    it("combines since and excludeTypes filters", async () => {
      kv._store.set("tm:t1", JSON.stringify([msg1, msg2, msg3, msg4, msg5]));

      const result = await store.listMessages("t1", { since: 1, excludeTypes: ["tool-result", "status"] });

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("m3");
      expect(result[1].id).toBe("m5");
    });

    it("returns empty when since is beyond all messages", async () => {
      kv._store.set("tm:t1", JSON.stringify([msg1, msg2, msg3]));

      const result = await store.listMessages("t1", { since: 100 });

      expect(result).toEqual([]);
    });
  });

  describe("deleteMessages", () => {
    it("deletes from both KV and R2", async () => {
      kv._store.set("tm:t1", JSON.stringify([msg1]));
      r2._store.set("task-messages/t1.json", JSON.stringify([msg1]));

      await store.deleteMessages("t1");

      expect(kv.delete).toHaveBeenCalledWith("tm:t1");
      expect(r2.delete).toHaveBeenCalledWith("task-messages/t1.json");
      expect(kv._store.has("tm:t1")).toBe(false);
      expect(r2._store.has("task-messages/t1.json")).toBe(false);
    });

    it("handles KV delete failure gracefully", async () => {
      (kv.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("KV down"));
      r2._store.set("task-messages/t1.json", JSON.stringify([msg1]));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await store.deleteMessages("t1");

      expect(r2.delete).toHaveBeenCalledWith("task-messages/t1.json");
      logSpy.mockRestore();
    });
  });

  describe("graceful degradation (no KV)", () => {
    let storeNoKV: TaskMessageStore;

    beforeEach(() => {
      storeNoKV = new TaskMessageStore(r2, null);
    });

    it("reads from R2 when KV is null", async () => {
      r2._store.set("task-messages/t1.json", JSON.stringify([msg1, msg3]));

      const result = await storeNoKV.listMessages("t1");

      expect(result).toHaveLength(2);
    });

    it("writes to R2 only when KV is null", async () => {
      await storeNoKV.appendMessages("t1", [msg1]);

      expect(r2._store.has("task-messages/t1.json")).toBe(true);
      expect(kv.put).not.toHaveBeenCalled();
    });

    it("deletes from R2 only when KV is null", async () => {
      r2._store.set("task-messages/t1.json", JSON.stringify([msg1]));

      await storeNoKV.deleteMessages("t1");

      expect(r2.delete).toHaveBeenCalledWith("task-messages/t1.json");
    });
  });

  describe("KV failure fallback", () => {
    it("falls through to R2 when KV get throws", async () => {
      (kv.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("KV down"));
      r2._store.set("task-messages/t1.json", JSON.stringify([msg1, msg3]));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await store.listMessages("t1");

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("m1");
      logSpy.mockRestore();
    });

    it("falls through to R2 on KV failure during append", async () => {
      (kv.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("KV down"));
      r2._store.set("task-messages/t1.json", JSON.stringify([msg1]));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await store.appendMessages("t1", [msg3]);

      const stored = JSON.parse(r2._store.get("task-messages/t1.json")!);
      expect(stored).toHaveLength(2);
      logSpy.mockRestore();
    });
  });

  describe("data integrity", () => {
    it("preserves message fields through write/read cycle", async () => {
      const msgWithInput: TaskMessage = {
        id: "mx", task_id: "t1", seq: 10, type: "tool-call",
        tool: "Bash", call_id: "cx", content: "running command",
        input: { command: "ls -la", timeout: 5000 },
        output: "total 48\ndrwxr-xr-x  12 user  staff  384 May 19 10:00 .",
      };

      await store.appendMessages("t1", [msgWithInput]);
      const result = await store.listMessages("t1");

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(msgWithInput);
    });

    it("handles messages without optional input field", async () => {
      const msgNoInput: TaskMessage = {
        id: "mn", task_id: "t1", seq: 1, type: "text",
        tool: "", call_id: "", content: "hello", output: "",
      };

      await store.appendMessages("t1", [msgNoInput]);
      const result = await store.listMessages("t1");

      expect(result[0].input).toBeUndefined();
    });

    it("maintains message order across appends", async () => {
      await store.appendMessages("t1", [msg1, msg2]);
      await store.appendMessages("t1", [msg3, msg4]);
      await store.appendMessages("t1", [msg5]);

      const result = await store.listMessages("t1");

      expect(result).toHaveLength(5);
      expect(result.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
