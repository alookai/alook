import { createElement, type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  mockElementGeometry,
  render,
  screen,
  setupUser,
  within,
} from "@/test/react-dom-harness";
import type { BlogIndexPost } from "./model";
import {
  RecentPosts,
  replaceRecentPostsTopicUrl,
  subscribeToRecentPostsTopicHash,
} from "./recent-posts";

const inputCapability = vi.hoisted(() => ({
  breakpoint: "desktop" as "desktop" | "mobile" | "unknown",
  hoverCapable: true,
}));

vi.mock("@/hooks/use-mobile", () => ({
  useBreakpoint: () => inputCapability.breakpoint,
}));

vi.mock("@/hooks/use-hover-capable", () => ({
  useHoverCapable: () => inputCapability.hoverCapable,
}));

vi.mock("next/image", () => ({
  default: ({ fill: _fill, ...props }: Record<string, unknown>) =>
    createElement("img", props),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) =>
    createElement("a", props, children),
}));

function recentPost(
  slug: string,
  topicId: string,
  topicLabel: string,
): BlogIndexPost {
  return {
    slug,
    title: slug,
    date: "2026-08-20",
    author: "Alook",
    excerpt: `${slug} excerpt`,
    readingTime: "5 min read",
    imageUrl: `/og/blog/${slug}`,
    topicId,
    topicLabel,
  };
}

function renderedTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("h3"), (heading) =>
    heading.textContent ?? "");
}

describe("RecentPosts", () => {
  beforeEach(() => {
    inputCapability.breakpoint = "desktop";
    inputCapability.hoverCapable = true;
  });

  it("keeps browser-only synchronization inert when window is unavailable", () => {
    const browserWindow = window;
    const selectTopic = vi.fn();
    vi.stubGlobal("window", undefined);
    try {
      expect(subscribeToRecentPostsTopicHash(
        new Set(["foundations"]),
        selectTopic,
      )).toBeUndefined();
      expect(() => replaceRecentPostsTopicUrl("foundations")).not.toThrow();
    } finally {
      vi.stubGlobal("window", browserWindow);
    }
    expect(selectTopic).not.toHaveBeenCalled();
  });

  it("filters Recent cards, renders the empty state, and returns to All", async () => {
    const user = setupUser();
    const posts = [
      recentPost("newest", "foundations", "Foundations"),
      recentPost("middle", "coding", "Coding"),
      recentPost("oldest", "foundations", "Foundations"),
    ];
    const topics = [
      { id: "foundations", label: "Foundations" },
      { id: "coding", label: "Coding" },
      { id: "empty", label: "Empty" },
    ];
    const rendered = render(createElement(RecentPosts, { posts, topics }));

    expect(renderedTitles(rendered.container)).toEqual(["newest", "middle", "oldest"]);

    const codingButton = screen.getByRole("button", { name: "Coding" });
    await user.click(codingButton);
    expect(codingButton).toHaveAttribute("aria-pressed", "true");
    expect(renderedTitles(rendered.container)).toEqual(["middle"]);

    const emptyButton = screen.getByRole("button", { name: "Empty" });
    await user.click(emptyButton);
    expect(emptyButton).toHaveAttribute("aria-pressed", "true");
    expect(renderedTitles(rendered.container)).toEqual([]);
    expect(screen.getByText("No recent stories in this topic yet.")).toBeVisible();

    const allButton = screen.getByRole("button", { name: "All" });
    await user.click(allButton);
    expect(allButton).toHaveAttribute("aria-pressed", "true");
    expect(renderedTitles(rendered.container)).toEqual(["newest", "middle", "oldest"]);
  });

  it("syncs the selected topic with the URL hash and browser history", async () => {
    const user = setupUser();
    const posts = [
      recentPost("newest", "foundations", "Foundations"),
      recentPost("middle", "coding", "Coding"),
      recentPost("oldest", "foundations", "Foundations"),
    ];
    const topics = [
      { id: "foundations", label: "Foundations" },
      { id: "coding", label: "Coding" },
    ];
    const previousUrl = window.location.href;
    window.history.replaceState(null, "", "/blog?source=qa#%63oding");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const removeEventListener = vi.spyOn(window, "removeEventListener");

    try {
      const rendered = render(createElement(RecentPosts, { posts, topics }));
      const codingButton = screen.getByRole("button", { name: "Coding" });
      expect(codingButton).toHaveAttribute("aria-pressed", "true");
      expect(renderedTitles(rendered.container)).toEqual(["middle"]);

      await user.click(screen.getByRole("button", { name: "Foundations" }));
      expect(replaceState).toHaveBeenLastCalledWith(
        null,
        "",
        "/blog?source=qa#foundations",
      );

      await user.click(screen.getByRole("button", { name: "All" }));
      expect(replaceState).toHaveBeenLastCalledWith(null, "", "/blog?source=qa");

      window.history.replaceState(null, "", "/blog?source=qa#not-a-topic");
      fireEvent(window, new HashChangeEvent("hashchange"));
      expect(renderedTitles(rendered.container)).toEqual(["newest", "middle", "oldest"]);

      rendered.unmount();
      expect(removeEventListener).toHaveBeenCalledWith("hashchange", expect.any(Function));
    } finally {
      replaceState.mockRestore();
      removeEventListener.mockRestore();
      window.history.replaceState(null, "", previousUrl);
    }
  });

  it("keeps the topic rail viewport and fades inside the Blog content column", () => {
    render(createElement(RecentPosts, {
      posts: [recentPost("newest", "foundations", "Foundations")],
      topics: [
        { id: "foundations", label: "Foundations" },
        { id: "coding", label: "Coding" },
      ],
    }));

    const scroller = screen.getByTestId("blog-topic-scroller");
    expect(scroller.parentElement).toHaveClass("relative", "mt-3", "sm:mt-6");
    expect(scroller).toHaveClass("thin-scrollbar", "scrollbar-none", "overflow-x-auto");

    const topicNav = within(scroller).getByRole("navigation", {
      name: "Filter recent posts",
    });
    expect(topicNav).toHaveClass("w-max", "min-w-full");
    for (const button of within(topicNav).getAllByRole("button")) {
      expect(button).toHaveClass("shrink-0");
    }
  });

  it("uses the shared rail owner for directional fades and desktop wheel ownership", () => {
    const posts = [recentPost("newest", "foundations", "Foundations")];
    const topics = [
      { id: "foundations", label: "Foundations" },
      { id: "coding", label: "Coding" },
    ];
    render(createElement(RecentPosts, { posts, topics }));
    const scroller = screen.getByTestId("blog-topic-scroller");
    mockElementGeometry(scroller, {
      scrollLeft: 0,
      scrollWidth: 300,
      clientWidth: 100,
      left: 0,
      right: 100,
    });
    mockElementGeometry(screen.getByRole("button", { name: "All" }), {
      left: 0,
      right: 44,
    });
    fireEvent.scroll(scroller);

    expect(screen.queryByTestId("blog-topic-fade-left")).not.toBeInTheDocument();
    expect(screen.getByTestId("blog-topic-fade-right")).toBeVisible();

    const translated = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    });
    fireEvent(scroller, translated);
    expect(scroller.scrollLeft).toBe(40);
    expect(translated.defaultPrevented).toBe(true);
    expect(screen.getByTestId("blog-topic-fade-left")).toBeVisible();

    scroller.scrollLeft = 200;
    const boundary = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    });
    fireEvent(scroller, boundary);
    expect(scroller.scrollLeft).toBe(200);
    expect(boundary.defaultPrevented).toBe(false);
  });

  it.each([
    { breakpoint: "mobile" as const, hoverCapable: true },
    { breakpoint: "desktop" as const, hoverCapable: false },
  ])("does not translate the Blog wheel with $breakpoint/$hoverCapable input", ({
    breakpoint,
    hoverCapable,
  }) => {
    inputCapability.breakpoint = breakpoint;
    inputCapability.hoverCapable = hoverCapable;
    render(createElement(RecentPosts, {
      posts: [recentPost("newest", "foundations", "Foundations")],
      topics: [{ id: "foundations", label: "Foundations" }],
    }));
    const scroller = screen.getByTestId("blog-topic-scroller");
    mockElementGeometry(scroller, {
      scrollLeft: 0,
      scrollWidth: 300,
      clientWidth: 100,
      left: 0,
      right: 100,
    });

    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    });
    fireEvent(scroller, wheel);

    expect(scroller.scrollLeft).toBe(0);
    expect(wheel.defaultPrevented).toBe(false);
  });
});
