import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  controller: vi.fn(() => ({ marker: "controller" })),
  view: vi.fn(),
}));

vi.mock("./community-onboarding-guide-controller", () => ({
  useCommunityOnboardingGuideController: mocks.controller,
}));
vi.mock("./community-onboarding-guide-view", () => ({
  renderCommunityOnboardingGuide: mocks.view,
}));

import * as facade from "./community-onboarding-guide";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const readWebSource = (path: string) => readFileSync(resolve(webRoot, path), "utf8");

describe("CommunityOnboardingGuide facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.view.mockReturnValue(React.createElement("guide-view"));
  });

  it("retains exactly ten runtime exports", () => {
    expect(Object.keys(facade).sort()).toEqual([
      "CommunityOnboardingGuide",
      "adjacentAvatarLayout",
      "dismissGuideOnTargetClick",
      "findGuideTarget",
      "guideCopy",
      "guidePopoverSide",
      "nonOverlappingPopoverLayout",
      "rectFitsViewport",
      "shouldAutoRouteGuide",
      "waitForTarget",
    ]);
  });

  it("calls one controller and one ordinary view helper without adding a wrapper", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(facade.CommunityOnboardingGuide));
    });
    expect(mocks.controller).toHaveBeenCalledOnce();
    expect(mocks.view).toHaveBeenCalledOnce();
    expect(mocks.view).toHaveBeenCalledWith({ marker: "controller" });
    expect(renderer.root.findAllByType("guide-view")).toHaveLength(1);
  });

  it("keeps the sole production importer on the original path and the facade boundary plain", () => {
    const importer = readWebSource("src/app/c/community-shell.tsx");
    expect(importer).toContain(
      'import { CommunityOnboardingGuide } from "@/components/community/onboarding/community-onboarding-guide"',
    );
    expect(importer.match(/<CommunityOnboardingGuide\s*\/>/g)).toHaveLength(1);

    const source = readWebSource(
      "src/components/community/onboarding/community-onboarding-guide.tsx",
    );
    expect(source).toContain("const controller = useCommunityOnboardingGuideController();");
    expect(source).toContain("return renderCommunityOnboardingGuide(controller);");
    expect(source).not.toMatch(/createElement|<CommunityOnboardingGuideView|<Provider|<Fragment/);
  });
});
