import { createElement, type PropsWithChildren } from "react";
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { BlogIndexPost } from "./model";
import { RecentPosts } from "./recent-posts";

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
  it("filters only the supplied Recent cards and returns to All", () => {
    const posts = [
      recentPost("newest", "foundations", "Foundations"),
      recentPost("middle", "coding", "Coding"),
      recentPost("oldest", "foundations", "Foundations"),
    ];
    const topics = [
      { id: "foundations", label: "Foundations" },
      { id: "coding", label: "Coding" },
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
});
