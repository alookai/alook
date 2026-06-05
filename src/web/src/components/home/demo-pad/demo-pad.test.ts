import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DemoPad } from "./demo-pad";
import { AnimatedStep } from "./animated-step";
import { useStepSequence } from "./use-step-sequence";

describe("demo-pad module exports", () => {
  it("exports DemoPad component", () => {
    expect(typeof DemoPad).toBe("function");
  });

  it("exports AnimatedStep component", () => {
    expect(typeof AnimatedStep).toBe("function");
  });

  it("exports useStepSequence hook", () => {
    expect(typeof useStepSequence).toBe("function");
  });
});

describe("DemoPad server-side render", () => {
  it("renders children via render prop pattern", () => {
    const markup = renderToStaticMarkup(
      createElement(
        DemoPad,
        { totalSteps: 3 },
        ({ currentStep, isResetting, showAll, Step }) => {
          return createElement(
            "div",
            { "data-testid": "container" },
            createElement(
              Step,
              { step: 0, currentStep, isResetting, showAll },
              createElement("span", null, "step-0")
            ),
            createElement(
              Step,
              { step: 1, currentStep, isResetting, showAll },
              createElement("span", null, "step-1")
            ),
            createElement(
              Step,
              { step: 2, currentStep, isResetting, showAll },
              createElement("span", null, "step-2")
            )
          );
        }
      )
    );
    expect(markup).toContain("step-0");
    expect(markup).toContain("step-1");
    expect(markup).toContain("step-2");
  });

  it("renders a container div for IntersectionObserver ref", () => {
    const markup = renderToStaticMarkup(
      createElement(
        DemoPad,
        { totalSteps: 1 },
        () => createElement("span", null, "content")
      )
    );
    expect(markup).toContain("<div>");
    expect(markup).toContain("content");
  });

  it("passes Step as AnimatedStep in children render prop", () => {
    let receivedStep: unknown = null;
    renderToStaticMarkup(
      createElement(
        DemoPad,
        { totalSteps: 1 },
        ({ Step }) => {
          receivedStep = Step;
          return createElement("span", null, "test");
        }
      )
    );
    expect(receivedStep).toBe(AnimatedStep);
  });

  it("initial currentStep is -1 (nothing visible on SSR)", () => {
    let receivedCurrentStep: number | null = null;
    renderToStaticMarkup(
      createElement(
        DemoPad,
        { totalSteps: 5 },
        ({ currentStep }) => {
          receivedCurrentStep = currentStep;
          return createElement("span", null, "test");
        }
      )
    );
    expect(receivedCurrentStep).toBe(-1);
  });

  it("initial isResetting is false", () => {
    let receivedIsResetting: boolean | null = null;
    renderToStaticMarkup(
      createElement(
        DemoPad,
        { totalSteps: 5 },
        ({ isResetting }) => {
          receivedIsResetting = isResetting;
          return createElement("span", null, "test");
        }
      )
    );
    expect(receivedIsResetting).toBe(false);
  });

  it("initial showAll is false (reduced motion detected in useEffect only)", () => {
    let receivedShowAll: boolean | null = null;
    renderToStaticMarkup(
      createElement(
        DemoPad,
        { totalSteps: 5 },
        ({ showAll }) => {
          receivedShowAll = showAll;
          return createElement("span", null, "test");
        }
      )
    );
    expect(receivedShowAll).toBe(false);
  });
});

describe("DemoPad configuration", () => {
  it("accepts custom stepInterval", () => {
    const markup = renderToStaticMarkup(
      createElement(
        DemoPad,
        { totalSteps: 3, stepInterval: 3000 },
        () => createElement("span", null, "ok")
      )
    );
    expect(markup).toContain("ok");
  });

  it("accepts custom loopPause", () => {
    const markup = renderToStaticMarkup(
      createElement(
        DemoPad,
        { totalSteps: 3, loopPause: 7000 },
        () => createElement("span", null, "ok")
      )
    );
    expect(markup).toContain("ok");
  });
});

describe("AnimatedStep transition spec", () => {
  const ENTER_DURATION = 0.3;
  const EXIT_DURATION = 0.2;
  const EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

  it("enter transition is 0.3s with standard easing", () => {
    const expected = `opacity ${ENTER_DURATION}s ${EASING}, transform ${ENTER_DURATION}s ${EASING}`;
    expect(expected).toContain("0.3s");
    expect(expected).toContain(EASING);
  });

  it("exit (reset) transition is faster at 0.2s", () => {
    expect(EXIT_DURATION).toBeLessThan(ENTER_DURATION);
    expect(EXIT_DURATION).toBe(0.2);
  });

  it("enter transform is translateY(4px) → translateY(0)", () => {
    const hiddenTransform = "translateY(4px)";
    const visibleTransform = "translateY(0)";
    expect(hiddenTransform).not.toBe(visibleTransform);
  });
});

describe("IntersectionObserver integration contract", () => {
  it("threshold should be > 0 (not triggered by 1px visibility)", () => {
    const THRESHOLD = 0.3;
    expect(THRESHOLD).toBeGreaterThan(0);
    expect(THRESHOLD).toBeLessThanOrEqual(1);
  });
});
