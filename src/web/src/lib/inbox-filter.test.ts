import { createStore } from "@tanstack/store";
import { QueryClient } from "@tanstack/react-query";
const owner = {
  userId: "viewer", queryClient: new QueryClient(),
  lifecycle: createStore({ active: true, generation: 0 }),
  preferences: createStore({ inboxFilterTypes: ["user_dm_message"] as import("./inbox-filter").InboxFilterType[], hydrated: true, lastWorkspaceSlug: null as string | null }),
};
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getInboxFilterTypes,
  readStoredInboxFilterTypes,
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
    expect(readStoredInboxFilterTypes("viewer")).toEqual(DEFAULT_INBOX_TYPES);
  });

  it("returns parsed types from localStorage", () => {
    storage["alook:viewer:inbox-filter-types"] = JSON.stringify(["user_dm_message", "calendar_event"]);
    expect(readStoredInboxFilterTypes("viewer")).toEqual(["user_dm_message", "calendar_event"]);
  });

  it("filters out invalid types", () => {
    storage["alook:viewer:inbox-filter-types"] = JSON.stringify(["user_dm_message", "invalid_type"]);
    expect(readStoredInboxFilterTypes("viewer")).toEqual(["user_dm_message"]);
  });

  it("returns default when all types invalid", () => {
    storage["alook:viewer:inbox-filter-types"] = JSON.stringify(["invalid1", "invalid2"]);
    expect(readStoredInboxFilterTypes("viewer")).toEqual(DEFAULT_INBOX_TYPES);
  });

  it("ensures mandatory types are included", () => {
    storage["alook:viewer:inbox-filter-types"] = JSON.stringify(["calendar_event"]);
    const result = readStoredInboxFilterTypes("viewer");
    expect(result).toContain("user_dm_message");
    expect(result).toContain("calendar_event");
  });

  it("returns default on JSON parse error", () => {
    storage["alook:viewer:inbox-filter-types"] = "not-json{{{";
    expect(readStoredInboxFilterTypes("viewer")).toEqual(DEFAULT_INBOX_TYPES);
  });

  it("returns default when window is undefined", () => {
    vi.stubGlobal("window", undefined);
    expect(readStoredInboxFilterTypes("viewer")).toEqual(DEFAULT_INBOX_TYPES);
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
    setInboxFilterTypes(owner, ["user_dm_message", "calendar_event"]);
    const saved = JSON.parse(storage["alook:viewer:inbox-filter-types"]);
    expect(saved).toContain("user_dm_message");
    expect(saved).toContain("calendar_event");
  });

  it("adds mandatory types if not included", () => {
    setInboxFilterTypes(owner, ["calendar_event"]);
    const saved = JSON.parse(storage["alook:viewer:inbox-filter-types"]);
    expect(saved).toContain("user_dm_message");
    expect(saved).toContain("calendar_event");
  });
});

describe("scoped preference Store", () => {
  it("publishes to the owner Store and does not read another account's selection", () => {
    setInboxFilterTypes(owner, ["calendar_event"]);
    expect(getInboxFilterTypes(owner)).toEqual(["user_dm_message", "calendar_event"]);
    const other = { ...owner, userId: "other", preferences: createStore({ inboxFilterTypes: [...DEFAULT_INBOX_TYPES], hydrated: true, lastWorkspaceSlug: null as string | null }) };
    expect(getInboxFilterTypes(other)).toEqual(DEFAULT_INBOX_TYPES);
  });
  it("does not write after owner retirement", () => {
    const previous = getInboxFilterTypes(owner);
    owner.lifecycle.setState((state) => ({ ...state, active: false }));
    setInboxFilterTypes(owner, ["email_notification"]);
    expect(getInboxFilterTypes(owner)).toBe(previous);
  });
});
