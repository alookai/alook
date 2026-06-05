import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnimatedStep } from "./animated-step";

describe("AnimatedStep", () => {
  const child = createElement("span", { "data-testid": "child" }, "hello");

  it("renders children when showAll is true regardless of step state", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AnimatedStep,
        { step: 5, currentStep: 0, isResetting: false, showAll: true },
        child
      )
    );
    expect(markup).toContain("hello");
    expect(markup).not.toContain("opacity");
  });

  it("renders with opacity 1 and translateY(0) when step is visible", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AnimatedStep,
        { step: 2, currentStep: 3, isResetting: false, showAll: false },
        child
      )
    );
    expect(markup).toContain("opacity:1");
    expect(markup).toContain("translateY(0)");
  });

  it("renders with opacity 0 and translateY(4px) when step is not yet visible", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AnimatedStep,
        { step: 3, currentStep: 1, isResetting: false, showAll: false },
        child
      )
    );
    expect(markup).toContain("opacity:0");
    expect(markup).toContain("translateY(4px)");
  });

  it("renders with opacity 0 when isResetting is true", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AnimatedStep,
        { step: 0, currentStep: 6, isResetting: true, showAll: false },
        child
      )
    );
    expect(markup).toContain("opacity:0");
  });

  it("uses 0.3s enter transition when not resetting", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AnimatedStep,
        { step: 0, currentStep: 0, isResetting: false, showAll: false },
        child
      )
    );
    expect(markup).toContain("0.3s");
    expect(markup).toContain("cubic-bezier(0.4, 0, 0.2, 1)");
  });

  it("uses 0.2s exit transition when resetting", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AnimatedStep,
        { step: 0, currentStep: 6, isResetting: true, showAll: false },
        child
      )
    );
    expect(markup).toContain("0.2s");
  });

  it("renders step visible at exact threshold (step === currentStep)", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AnimatedStep,
        { step: 4, currentStep: 4, isResetting: false, showAll: false },
        child
      )
    );
    expect(markup).toContain("opacity:1");
  });

  it("renders step hidden when currentStep is -1 (initial state)", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AnimatedStep,
        { step: 0, currentStep: -1, isResetting: false, showAll: false },
        child
      )
    );
    expect(markup).toContain("opacity:0");
  });
});
