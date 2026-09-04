import { createElement, type PropsWithChildren } from "react";
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlogIndexPost } from "./model";
import { RecentPosts } from "./recent-posts";

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
  default: (props: Record<string, unknown>) => createElement("img", props),
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

function renderedTitles(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType("h3")
    .map((heading) => heading.children.join(""));
}

describe("RecentPosts", () => {
  beforeEach(() => {
    inputCapability.breakpoint = "desktop";
    inputCapability.hoverCapable = true;
  });

  it("filters Recent cards, renders the empty state, and returns to All", () => {
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
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        createElement(RecentPosts, { posts, topics }),
      );
    });

    expect(renderedTitles(renderer!)).toEqual(["newest", "middle", "oldest"]);

    const codingButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Coding");
    act(() => codingButton?.props.onClick());

    expect(codingButton?.props["aria-pressed"]).toBe(true);
    expect(renderedTitles(renderer!)).toEqual(["middle"]);

    const emptyButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Empty");
    act(() => emptyButton?.props.onClick());

    expect(emptyButton?.props["aria-pressed"]).toBe(true);
    expect(renderedTitles(renderer!)).toEqual([]);
    expect(renderer!.root.findByType("p").children.join("")).toBe(
      "No recent stories in this topic yet.",
    );

    const allButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "All");
    act(() => allButton?.props.onClick());

    expect(allButton?.props["aria-pressed"]).toBe(true);
    expect(renderedTitles(renderer!)).toEqual(["newest", "middle", "oldest"]);
  });

  it("syncs the selected topic with the URL hash and browser history", () => {
    const posts = [
      recentPost("newest", "foundations", "Foundations"),
      recentPost("middle", "coding", "Coding"),
      recentPost("oldest", "foundations", "Foundations"),
    ];
    const topics = [
      { id: "foundations", label: "Foundations" },
      { id: "coding", label: "Coding" },
    ];
    let hashChangeListener: (() => void) | undefined;
    const replaceState = vi.fn();
    const removeEventListener = vi.fn();

    vi.stubGlobal("window", {
      location: {
        hash: "#%63oding",
        pathname: "/blog",
        search: "?source=qa",
      },
      history: { replaceState },
      addEventListener: vi.fn(
        (eventName: string, listener: () => void) => {
          if (eventName === "hashchange") hashChangeListener = listener;
        },
      ),
      removeEventListener,
    });

    let renderer: ReactTestRenderer;
    try {
      act(() => {
        renderer = TestRenderer.create(
          createElement(RecentPosts, { posts, topics }),
        );
      });

      const codingButton = renderer!.root
        .findAllByType("button")
        .find((button) => button.children.join("") === "Coding");
      expect(codingButton?.props["aria-pressed"]).toBe(true);
      expect(renderedTitles(renderer!)).toEqual(["middle"]);

      const foundationsButton = renderer!.root
        .findAllByType("button")
        .find((button) => button.children.join("") === "Foundations");
      act(() => foundationsButton?.props.onClick());
      expect(replaceState).toHaveBeenLastCalledWith(
        null,
        "",
        "/blog?source=qa#foundations",
      );

      const allButton = renderer!.root
        .findAllByType("button")
        .find((button) => button.children.join("") === "All");
      act(() => allButton?.props.onClick());
      expect(replaceState).toHaveBeenLastCalledWith(
        null,
        "",
        "/blog?source=qa",
      );

      window.location.hash = "#not-a-topic";
      act(() => hashChangeListener?.());
      expect(renderedTitles(renderer!)).toEqual(["newest", "middle", "oldest"]);

      act(() => renderer!.unmount());
      expect(removeEventListener).toHaveBeenCalledWith(
        "hashchange",
        hashChangeListener,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the shared rail owner for directional fades and desktop wheel ownership", () => {
    const posts = [recentPost("newest", "foundations", "Foundations")];
    const topics = [
      { id: "foundations", label: "Foundations" },
      { id: "coding", label: "Coding" },
    ];
    const scroller = {
      scrollLeft: 0,
      scrollWidth: 300,
      clientWidth: 100,
      getBoundingClientRect: () => ({ left: 0, right: 100 }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const selected = {
      getBoundingClientRect: () => ({ left: 0, right: 44 }),
    };
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        createElement(RecentPosts, { posts, topics }),
        {
          createNodeMock: (element) =>
            element.props["data-testid"] === "blog-topic-scroller"
              ? scroller
              : element.type === "button" && element.props["aria-pressed"]
                ? selected
                : null,
        },
      );
    });

    expect(renderer!.root.findAllByProps({ "data-testid": "blog-topic-fade-left" }))
      .toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "data-testid": "blog-topic-fade-right" }))
      .toHaveLength(1);

    const wheelListener = scroller.addEventListener.mock.calls
      .find(([eventName]) => eventName === "wheel")?.[1] as ((event: WheelEvent) => void) | undefined;
    const preventDefault = vi.fn();
    expect(scroller.addEventListener).toHaveBeenCalledWith(
      "wheel",
      expect.any(Function),
      { passive: false },
    );
    act(() => wheelListener?.({
      deltaX: 0,
      deltaY: 40,
      ctrlKey: false,
      shiftKey: false,
      preventDefault,
    } as unknown as WheelEvent));
    expect(scroller.scrollLeft).toBe(40);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(renderer!.root.findAllByProps({ "data-testid": "blog-topic-fade-left" }))
      .toHaveLength(1);

    scroller.scrollLeft = 200;
    act(() => wheelListener?.({
      deltaX: 0,
      deltaY: 40,
      ctrlKey: false,
      shiftKey: false,
      preventDefault,
    } as unknown as WheelEvent));
    expect(scroller.scrollLeft).toBe(200);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it.each([
    { breakpoint: "mobile" as const, hoverCapable: true },
    { breakpoint: "desktop" as const, hoverCapable: false },
  ])("does not translate the Blog wheel with $breakpoint/$hoverCapable input", ({ breakpoint, hoverCapable }) => {
    inputCapability.breakpoint = breakpoint;
    inputCapability.hoverCapable = hoverCapable;
    const scroller = {
      scrollLeft: 0,
      scrollWidth: 300,
      clientWidth: 100,
      getBoundingClientRect: () => ({ left: 0, right: 100 }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const selected = {
      getBoundingClientRect: () => ({ left: 0, right: 44 }),
    };
    act(() => {
      TestRenderer.create(
        createElement(RecentPosts, {
          posts: [recentPost("newest", "foundations", "Foundations")],
          topics: [{ id: "foundations", label: "Foundations" }],
        }),
        {
          createNodeMock: (element) =>
            element.props["data-testid"] === "blog-topic-scroller"
              ? scroller
              : element.type === "button" && element.props["aria-pressed"]
                ? selected
                : null,
        },
      );
    });

    expect(scroller.scrollLeft).toBe(0);
    expect(scroller.addEventListener).not.toHaveBeenCalledWith(
      "wheel",
      expect.any(Function),
      { passive: false },
    );
  });
});
