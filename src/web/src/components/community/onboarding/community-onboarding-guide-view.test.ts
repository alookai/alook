import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommunityOnboardingGuideController } from "./community-onboarding-guide-types";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const readWebSource = (path: string) => readFileSync(resolve(webRoot, path), "utf8");

vi.mock("react-dom", async () => {
  const ReactModule = await import("react");
  return {
    createPortal: (child: React.ReactNode, container: Element) =>
      ReactModule.createElement("portal", { container }, child),
  };
});
vi.mock("@/components/avatar", () => ({
  GeneratedAvatar: (props: Record<string, unknown>) => React.createElement("avatar", props),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", props, children),
}));

import { renderCommunityOnboardingGuide } from "./community-onboarding-guide-view";

function controller(
  overrides: Partial<CommunityOnboardingGuideController> = {},
): CommunityOnboardingGuideController {
  return {
    copy: {
      target: { name: "create-bot" },
      eyebrow: "Step 2 of 4",
      title: "Create a bot with a voice of its own",
      route: "/c/me/bots",
    },
    state: { status: "active", stage: "bot", guideAvatarSeed: "guide-7" },
    popoverContainer: null,
    targetAvatarContainer: null,
    onSkip: vi.fn(),
    ...overrides,
  };
}

describe("renderCommunityOnboardingGuide", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns null unless both copy and state exist", () => {
    expect(renderCommunityOnboardingGuide(controller({ copy: null }))).toBeNull();
    expect(renderCommunityOnboardingGuide(controller({ state: null }))).toBeNull();
  });

  it("keeps one Fragment with popover then avatar portals and exact destinations", () => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const popoverContainer = { id: "popover" } as unknown as HTMLElement;
    const targetAvatarContainer = { id: "avatar" } as unknown as HTMLElement;
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(renderCommunityOnboardingGuide(controller({
        popoverContainer,
        targetAvatarContainer,
      })));
    });
    const portals = renderer.root.findAllByType("portal");
    expect(portals).toHaveLength(2);
    expect(portals.map((portal) => portal.props.container)).toEqual([
      popoverContainer,
      targetAvatarContainer,
    ]);
    expect(renderer.root.findByType("avatar").props).toEqual({
      seed: "guide-7",
      size: 28,
      className: "rounded-full ring-2 ring-background shadow-md",
    });

    const source = readWebSource(
      "src/components/community/onboarding/community-onboarding-guide-view.tsx",
    );
    expect(source.indexOf("? createPortal(")).toBeLessThan(
      source.lastIndexOf("? createPortal("),
    );
    expect(source).toContain("<>\n      {popoverContainer");
  });

  it("uses the exact fallback avatar seed", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(renderCommunityOnboardingGuide(controller({
        state: { status: "active", stage: "server" },
        targetAvatarContainer: {} as HTMLElement,
      })));
    });
    expect(renderer.root.findByType("avatar").props.seed).toBe("alook-guide");
  });

  it("keeps GuideCard DOM and the capture Escape listener lifecycle", () => {
    const calls: string[] = [];
    const onSkip = vi.fn();
    const replacementSkip = vi.fn(() => calls.push("skip"));
    let keydown!: (event: KeyboardEvent) => void;
    const handlers: Array<(event: KeyboardEvent) => void> = [];
    const addEventListener = vi.fn((name: string, handler: (event: KeyboardEvent) => void) => {
      if (name === "keydown") {
        keydown = handler;
        handlers.push(handler);
      }
    });
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener, removeEventListener });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(renderCommunityOnboardingGuide(controller({
        popoverContainer: {} as HTMLElement,
        onSkip,
      })));
    });
    expect(addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function), true);
    expect(renderer.root.findAllByProps({ className: "community-onboarding-card" }))
      .toHaveLength(1);
    expect(renderer.root.findAllByProps({ className: "community-onboarding-content" }))
      .toHaveLength(1);
    expect(renderer.root.findAllByProps({ className: "community-onboarding-meta" }))
      .toHaveLength(1);
    expect(renderer.root.findByProps({ className: "community-onboarding-eyebrow" }).children)
      .toEqual(["Step 2 of 4"]);
    expect(renderer.root.findByType("h2").children)
      .toEqual(["Create a bot with a voice of its own"]);
    const skip = renderer.root.findByType("button");
    expect(skip.props).toMatchObject({
      variant: "ghost",
      className: "community-onboarding-skip",
    });
    expect(skip.children).toEqual(["Skip guide"]);

    const ordinary = { key: "Enter", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    act(() => keydown(ordinary as unknown as KeyboardEvent));
    expect(onSkip).not.toHaveBeenCalled();
    const escape = {
      key: "Escape",
      preventDefault: vi.fn(() => calls.push("prevent")),
      stopPropagation: vi.fn(() => calls.push("stop")),
    };
    act(() => keydown(escape as unknown as KeyboardEvent));
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(escape.stopPropagation).toHaveBeenCalledOnce();
    expect(onSkip).toHaveBeenCalledOnce();
    calls.length = 0;

    const firstHandler = handlers[0]!;
    act(() => {
      renderer.update(renderCommunityOnboardingGuide(controller({
        popoverContainer: {} as HTMLElement,
        onSkip: replacementSkip,
      })));
    });
    expect(removeEventListener).toHaveBeenCalledWith("keydown", firstHandler, true);
    expect(addEventListener).toHaveBeenCalledTimes(2);
    expect(handlers[1]).not.toBe(firstHandler);
    expect(removeEventListener.mock.invocationCallOrder[0])
      .toBeLessThan(addEventListener.mock.invocationCallOrder[1]!);

    const replacementEscape = {
      key: "Escape",
      preventDefault: vi.fn(() => calls.push("prevent")),
      stopPropagation: vi.fn(() => calls.push("stop")),
    };
    act(() => keydown(replacementEscape as unknown as KeyboardEvent));
    expect(calls).toEqual(["prevent", "stop", "skip"]);
    expect(replacementSkip).toHaveBeenCalledOnce();
    expect(onSkip).toHaveBeenCalledOnce();

    const replacementHandler = keydown;
    act(() => renderer.unmount());
    expect(removeEventListener).toHaveBeenLastCalledWith("keydown", replacementHandler, true);
  });
});
