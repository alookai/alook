import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render, waitFor } from "@/test/react-dom-harness";

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => location.pathname }));

import { ThemeColorSync, syncThemeColorToVisibleBackground } from "./theme-color-sync";

afterEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
  document.body.style.backgroundColor = "";
  history.replaceState(null, "", "/");
});

function surfaces() {
  return render(<div data-slot="community-shell-root">
    <div style={{ backgroundColor: "rgb(250, 246, 238)" }}>
      <div data-testid="list" data-community-mobile-surface="list" />
    </div>
    <div style={{ backgroundColor: "rgb(255, 253, 248)" }}>
      <div data-testid="detail" hidden />
    </div>
    <ThemeColorSync />
  </div>);
}

const color = () => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content;

it("publishes list → retained chat → list without requiring a route or theme change", async () => {
  history.replaceState(null, "", "/c/channels/qa/general");
  document.body.style.backgroundColor = "rgb(224, 213, 192)";
  const { getByTestId } = surfaces();
  await waitFor(() => expect(color()).toBe("rgb(250, 246, 238)"));
  const list = getByTestId("list");
  const detail = getByTestId("detail");
  list.removeAttribute("data-community-mobile-surface");
  list.hidden = true;
  detail.hidden = false;
  detail.dataset.communityMobileSurface = "detail";
  await waitFor(() => expect(color()).toBe("rgb(255, 253, 248)"));
  detail.parentElement!.style.backgroundColor = "rgb(0, 0, 0)";
  syncThemeColorToVisibleBackground();
  expect(color()).toBe("rgb(0, 0, 0)");
  detail.removeAttribute("data-community-mobile-surface");
  detail.hidden = true;
  list.hidden = false;
  list.dataset.communityMobileSurface = "list";
  await waitFor(() => expect(color()).toBe("rgb(250, 246, 238)"));
});

it.each(["/", "/signin"])("ignores an embedded mobile community surface on %s", async (path) => {
  history.replaceState(null, "", path);
  document.body.style.backgroundColor = "rgb(224, 213, 192)";
  surfaces();
  await waitFor(() => expect(color()).toBe("rgb(224, 213, 192)"));
});

it("returns to the frame when the community breakpoint removes the active mobile marker", async () => {
  history.replaceState(null, "", "/c/me/qa");
  document.body.style.backgroundColor = "rgb(5, 5, 5)";
  const { getByTestId } = surfaces();
  await waitFor(() => expect(color()).toBe("rgb(250, 246, 238)"));
  getByTestId("list").removeAttribute("data-community-mobile-surface");
  await waitFor(() => expect(color()).toBe("rgb(5, 5, 5)"));
});
