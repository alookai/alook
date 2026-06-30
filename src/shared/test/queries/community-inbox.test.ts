import { describe, it, expect } from "vitest";
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
