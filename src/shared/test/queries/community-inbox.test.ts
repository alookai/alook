import { describe, it, expect, vi } from "vitest";
import * as inboxQueries from "../../src/db/queries/community/inbox";

// These tests pin the shape of the public API; SQL behavior is covered by
// integration runs against D1. The fact that this file imports cleanly
// also surfaces accidental query syntax regressions at typecheck time.

describe("community/inbox exports", () => {
  it("exports listForYouEvents", () => {
    expect(typeof inboxQueries.listForYouEvents).toBe("function");
  });
  it("exports listUnreadChannels", () => {
    expect(typeof inboxQueries.listUnreadChannels).toBe("function");
  });
  it("exports dismissEvent", () => {
    expect(typeof inboxQueries.dismissEvent).toBe("function");
  });
  it("exports dismissEvents", () => {
    expect(typeof inboxQueries.dismissEvents).toBe("function");
  });
  it("exports listDismissals", () => {
    expect(typeof inboxQueries.listDismissals).toBe("function");
  });
});

describe("dismissForYouForChannelBuilder", () => {
  function createInsertBuilderMock() {
    const chain: any = {};
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.onConflictDoNothing = vi.fn(() => ({ __builder: "insert-dismissal" }));
    return chain;
  }

  it("exports the builder function", () => {
    expect(typeof inboxQueries.dismissForYouForChannelBuilder).toBe("function");
  });

  it("returns a builder synchronously (usable in db.batch)", () => {
    const db = createInsertBuilderMock();
    const result = inboxQueries.dismissForYouForChannelBuilder(db, "u_1", "c_1");
    expect(result).toBeDefined();
    expect(result).not.toBeInstanceOf(Promise);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("uses the thread:<channelId> event key shape", () => {
    const db = createInsertBuilderMock();
    inboxQueries.dismissForYouForChannelBuilder(db, "u_1", "c_1");
    const valuesArg = db.values.mock.calls[0][0];
    expect(valuesArg).toMatchObject({
      userId: "u_1",
      eventKey: "thread:c_1",
    });
    expect(typeof valuesArg.dismissedAt).toBe("string");
  });
});

describe("dismissEvents short-circuit", () => {
  it("returns without touching db when keys empty", async () => {
    let called = false;
    const fakeDb = {
      insert() {
        called = true;
        return this;
      },
      values() { return this; },
      onConflictDoNothing() { return Promise.resolve(); },
    } as unknown as Parameters<typeof inboxQueries.dismissEvents>[0];
    await inboxQueries.dismissEvents(fakeDb, "u1", []);
    expect(called).toBe(false);
  });
});
