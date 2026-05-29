import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getInboxFilterTypes,
  setInboxFilterTypes,
  INBOX_FILTER_TYPES,
  INBOX_FILTER_LABELS,
  DEFAULT_INBOX_TYPES,
  MANDATORY_INBOX_TYPES,
} from "./inbox-filter.js";

describe("inbox-filter constants", () => {
  it("INBOX_FILTER_TYPES contains all expected types", () => {
    expect(INBOX_FILTER_TYPES).toContain("user_dm_message");
    expect(INBOX_FILTER_TYPES).toContain("calendar_event");
    expect(INBOX_FILTER_TYPES).toContain("email_notification");
    expect(INBOX_FILTER_TYPES).toHaveLength(3);
  });

  it("INBOX_FILTER_LABELS has labels for all types", () => {
    expect(INBOX_FILTER_LABELS.user_dm_message).toBe("DM");
    expect(INBOX_FILTER_LABELS.calendar_event).toBe("Calendar");
    expect(INBOX_FILTER_LABELS.email_notification).toBe("Email");
  });

  it("DEFAULT_INBOX_TYPES includes user_dm_message", () => {
    expect(DEFAULT_INBOX_TYPES).toContain("user_dm_message");
  });

  it("MANDATORY_INBOX_TYPES includes user_dm_message", () => {
    expect(MANDATORY_INBOX_TYPES).toContain("user_dm_message");
  });
});

describe("getInboxFilterTypes", () => {
  let storage: Record<string, string>;

  beforeEach(() => {
    storage = {};
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage[key] = value;
      }),
    });
  });

  it("returns default types when no localStorage value", () => {
    expect(getInboxFilterTypes()).toEqual(DEFAULT_INBOX_TYPES);
  });

  it("returns parsed types from localStorage", () => {
    storage["inbox-filter-types"] = JSON.stringify(["user_dm_message", "calendar_event"]);
    expect(getInboxFilterTypes()).toEqual(["user_dm_message", "calendar_event"]);
  });

  it("filters out invalid types", () => {
    storage["inbox-filter-types"] = JSON.stringify(["user_dm_message", "invalid_type"]);
    expect(getInboxFilterTypes()).toEqual(["user_dm_message"]);
  });

  it("returns default when all types invalid", () => {
    storage["inbox-filter-types"] = JSON.stringify(["invalid1", "invalid2"]);
    expect(getInboxFilterTypes()).toEqual(DEFAULT_INBOX_TYPES);
  });

  it("ensures mandatory types are included", () => {
    storage["inbox-filter-types"] = JSON.stringify(["calendar_event"]);
    const result = getInboxFilterTypes();
    expect(result).toContain("user_dm_message");
    expect(result).toContain("calendar_event");
  });

  it("returns default on JSON parse error", () => {
    storage["inbox-filter-types"] = "not-json{{{";
    expect(getInboxFilterTypes()).toEqual(DEFAULT_INBOX_TYPES);
  });

  it("returns default when window is undefined", () => {
    vi.stubGlobal("window", undefined);
    expect(getInboxFilterTypes()).toEqual(DEFAULT_INBOX_TYPES);
  });
});

describe("setInboxFilterTypes", () => {
  let storage: Record<string, string>;

  beforeEach(() => {
    storage = {};
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage[key] = value;
      }),
    });
  });

  it("saves types to localStorage", () => {
    setInboxFilterTypes(["user_dm_message", "calendar_event"]);
    const saved = JSON.parse(storage["inbox-filter-types"]);
    expect(saved).toContain("user_dm_message");
    expect(saved).toContain("calendar_event");
  });

  it("adds mandatory types if not included", () => {
    setInboxFilterTypes(["calendar_event"]);
    const saved = JSON.parse(storage["inbox-filter-types"]);
    expect(saved).toContain("user_dm_message");
    expect(saved).toContain("calendar_event");
  });
});
