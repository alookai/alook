import { describe, expect, it } from "vitest";
import {
  applyDiscardSuccessState,
  beginEmailFolderSwitch,
  getDiscardSuccessToastMessage,
  nextEmailLoadRequestId,
  shouldApplyEmailLoadResult,
  shouldShowHydrationShell,
} from "./email-page-state";

describe("email page state helpers", () => {
  it("starts loading immediately when switching folders", () => {
    expect(beginEmailFolderSwitch()).toEqual({
      body: null,
      composing: false,
      emails: [],
      loading: true,
      selectedId: null,
    });
  });

  it("only applies the latest email load result", () => {
    const first = nextEmailLoadRequestId(0);
    const second = nextEmailLoadRequestId(first);

    expect(shouldApplyEmailLoadResult(first, second)).toBe(false);
    expect(shouldApplyEmailLoadResult(second, second)).toBe(true);
  });

  it("clears discarded email selection and body", () => {
    const state = applyDiscardSuccessState({
      body: { content: "body", isHtml: false },
      emails: [{ id: "keep" }, { id: "discard" }],
      selectedId: "discard",
    }, "discard");

    expect(state).toEqual({
      body: null,
      emails: [{ id: "keep" }],
      selectedId: null,
    });
    expect(getDiscardSuccessToastMessage()).toBe("Moved to Untrust");
  });

  it("uses a hydration shell before client-only agent state is mounted", () => {
    expect(shouldShowHydrationShell({ mounted: false, agentLoading: false })).toBe(true);
    expect(shouldShowHydrationShell({ mounted: true, agentLoading: true })).toBe(true);
    expect(shouldShowHydrationShell({ mounted: true, agentLoading: false })).toBe(false);
  });
});
