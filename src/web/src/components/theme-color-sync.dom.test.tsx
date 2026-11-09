import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render, waitFor } from "@/test/react-dom-harness";

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => location.pathname }));

import { ThemeColorSync, syncThemeColorToVisibleBackground } from "./theme-color-sync";

const publicationListeners: EventListener[] = [];

afterEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
  document.body.style.backgroundColor = "";
  document.body.style.removeProperty("--app-edge-fade-color");
  for (const listener of publicationListeners.splice(0)) {
    window.removeEventListener("alook:theme-color-change", listener);
  }
  vi.restoreAllMocks();
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
const edgeColor = () => document.body.style.getPropertyValue("--app-edge-fade-color");

it("publishes startup paint and returns to the normal surface when startup ends", async () => {
  history.replaceState(null, "", "/c");
  document.body.style.backgroundColor = "rgb(224, 213, 192)";
  const { getByTestId } = render(<>
    <div data-testid="startup" data-community-startup-frame="">
      <div data-slot="community-frame-paint" style={{ backgroundColor: "rgb(250, 246, 238)" }} />
    </div>
    <div data-slot="community-shell-root">
      <div data-community-mobile-surface="list" style={{ backgroundColor: "rgb(255, 253, 248)" }} />
    </div>
    <ThemeColorSync />
  </>);
  await waitFor(() => expect(color()).toBe("rgb(250, 246, 238)"));
  expect(edgeColor()).toBe("rgb(250, 246, 238)");
  getByTestId("startup").removeAttribute("data-community-startup-frame");
  await waitFor(() => expect(color()).toBe("rgb(255, 253, 248)"));
  expect(edgeColor()).toBe("rgb(255, 253, 248)");
});

it("publishes list → retained chat → list without requiring a route or theme change", async () => {
  history.replaceState(null, "", "/c/channels/qa/general");
  document.body.style.backgroundColor = "rgb(224, 213, 192)";
  const { getByTestId } = surfaces();
  await waitFor(() => expect(color()).toBe("rgb(250, 246, 238)"));
  expect(edgeColor()).toBe("rgb(250, 246, 238)");
  const list = getByTestId("list");
  const detail = getByTestId("detail");
  list.removeAttribute("data-community-mobile-surface");
  list.hidden = true;
  detail.hidden = false;
  detail.dataset.communityMobileSurface = "detail";
  await waitFor(() => expect(color()).toBe("rgb(255, 253, 248)"));
  expect(edgeColor()).toBe("rgb(255, 253, 248)");
  detail.parentElement!.style.backgroundColor = "rgb(0, 0, 0)";
  syncThemeColorToVisibleBackground();
  expect(color()).toBe("rgb(0, 0, 0)");
  expect(edgeColor()).toBe("rgb(0, 0, 0)");
  detail.removeAttribute("data-community-mobile-surface");
  detail.hidden = true;
  list.hidden = false;
  list.dataset.communityMobileSurface = "list";
  await waitFor(() => expect(color()).toBe("rgb(250, 246, 238)"));
  expect(edgeColor()).toBe("rgb(250, 246, 238)");
});

it.each(["/", "/signin"])("ignores an embedded mobile community surface on %s", async (path) => {
  history.replaceState(null, "", path);
  document.body.style.backgroundColor = "rgb(224, 213, 192)";
  surfaces();
  await waitFor(() => expect(color()).toBe("rgb(224, 213, 192)"));
  expect(edgeColor()).toBe("rgb(224, 213, 192)");
});

it("returns to the frame when the community breakpoint removes the active mobile marker", async () => {
  history.replaceState(null, "", "/c/me/qa");
  document.body.style.backgroundColor = "rgb(5, 5, 5)";
  const { getByTestId } = surfaces();
  await waitFor(() => expect(color()).toBe("rgb(250, 246, 238)"));
  getByTestId("list").removeAttribute("data-community-mobile-surface");
  await waitFor(() => expect(color()).toBe("rgb(5, 5, 5)"));
  expect(edgeColor()).toBe("rgb(5, 5, 5)");
});

it("publishes edge and native colors before notifying and avoids unchanged writes", () => {
  document.body.style.backgroundColor = "rgb(17, 34, 51)";
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = "previous";
  document.head.appendChild(meta);
  const publications: string[][] = [];
  const listener = () => { publications.push([meta.content, edgeColor()]); };
  publicationListeners.push(listener);
  window.addEventListener("alook:theme-color-change", listener);
  const writeStyle = vi.spyOn(document.body.style, "setProperty");
  const writeMeta = vi.spyOn(meta, "content", "set");

  syncThemeColorToVisibleBackground();
  syncThemeColorToVisibleBackground();
  expect(publications).toEqual([["rgb(17, 34, 51)", "rgb(17, 34, 51)"]]);
  expect(writeStyle).toHaveBeenCalledOnce();
  expect(writeMeta).toHaveBeenCalledOnce();

  document.body.style.backgroundColor = "rgb(64, 32, 16)";
  syncThemeColorToVisibleBackground();
  expect(publications.at(-1)).toEqual(["rgb(64, 32, 16)", "rgb(64, 32, 16)"]);
  expect(publications).toHaveLength(2);
});

it("notifies missing edge publication without rewriting current native metadata", () => {
  document.body.style.backgroundColor = "rgb(17, 34, 51)";
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = "rgb(17, 34, 51)";
  document.head.appendChild(meta);
  const notified = vi.fn();
  publicationListeners.push(notified);
  window.addEventListener("alook:theme-color-change", notified);
  const writeMeta = vi.spyOn(meta, "content", "set");
  syncThemeColorToVisibleBackground();
  syncThemeColorToVisibleBackground();
  expect(edgeColor()).toBe("rgb(17, 34, 51)");
  expect(notified).toHaveBeenCalledOnce();
  expect(writeMeta).not.toHaveBeenCalled();
});

it("preserves both prior publications for a transparent document", () => {
  document.body.style.backgroundColor = "transparent";
  document.body.style.setProperty("--app-edge-fade-color", "prior-edge");
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = "prior-native";
  document.head.appendChild(meta);
  syncThemeColorToVisibleBackground();
  expect(color()).toBe("prior-native");
  expect(edgeColor()).toBe("prior-edge");
});
