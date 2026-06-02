import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createKeyboardScrollController,
  attachKeyboardScroll,
} from "../use-keyboard-scroll";

function createMockTarget(container?: HTMLElement | null) {
  const scrollIntoView = vi.fn();
  const target = {
    scrollIntoView,
    closest: vi.fn((selector: string) => {
      if (selector === "[data-keyboard-offset]") return container ?? null;
      return null;
    }),
  } as unknown as HTMLElement;
  return { target, scrollIntoView };
}

function createMockContainer() {
  return { style: { transform: "" } } as unknown as HTMLElement;
}

describe("createKeyboardScrollController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to scrollIntoView when no visualViewport available", () => {
    const { target, scrollIntoView } = createMockTarget(null);
    Object.defineProperty(globalThis, "window", {
      value: { innerHeight: 800, visualViewport: undefined },
      writable: true,
      configurable: true,
    });
    const { handler } = createKeyboardScrollController(() => target, true);

    handler();
    vi.advanceTimersByTime(100);

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "end",
      behavior: "smooth",
    });

    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it("applies transform offset when keyboard is open and container exists", () => {
    const container = createMockContainer();
    const { target } = createMockTarget(container);
    Object.defineProperty(globalThis, "window", {
      value: {
        innerHeight: 800,
        visualViewport: { height: 500, offsetTop: 0 },
      },
      writable: true,
      configurable: true,
    });
    const { handler } = createKeyboardScrollController(() => target, true);

    handler();
    vi.advanceTimersByTime(100);

    expect(container.style.transform).toBe("translateY(-300px)");

    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it("clears transform when keyboard offset is zero", () => {
    const container = createMockContainer();
    container.style.transform = "translateY(-300px)";
    const { target } = createMockTarget(container);
    Object.defineProperty(globalThis, "window", {
      value: {
        innerHeight: 800,
        visualViewport: { height: 800, offsetTop: 0 },
      },
      writable: true,
      configurable: true,
    });
    const { handler } = createKeyboardScrollController(() => target, true);

    handler();
    vi.advanceTimersByTime(100);

    expect(container.style.transform).toBe("");

    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it("does NOT fire when not focused", () => {
    const container = createMockContainer();
    const { target } = createMockTarget(container);
    Object.defineProperty(globalThis, "window", {
      value: {
        innerHeight: 800,
        visualViewport: { height: 500, offsetTop: 0 },
      },
      writable: true,
      configurable: true,
    });
    const { handler } = createKeyboardScrollController(() => target, false);

    handler();
    vi.advanceTimersByTime(100);

    expect(container.style.transform).toBe("");

    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it("debounces rapid resize events", () => {
    const container = createMockContainer();
    const { target } = createMockTarget(container);
    Object.defineProperty(globalThis, "window", {
      value: {
        innerHeight: 800,
        visualViewport: { height: 500, offsetTop: 0 },
      },
      writable: true,
      configurable: true,
    });
    const { handler } = createKeyboardScrollController(() => target, true);

    handler();
    vi.advanceTimersByTime(50);
    handler();
    vi.advanceTimersByTime(50);
    handler();
    vi.advanceTimersByTime(100);

    expect(container.style.transform).toBe("translateY(-300px)");

    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it("cleanup clears pending timeout and resets transform", () => {
    const container = createMockContainer();
    container.style.transform = "translateY(-300px)";
    const { target } = createMockTarget(container);
    Object.defineProperty(globalThis, "window", {
      value: {
        innerHeight: 800,
        visualViewport: { height: 500, offsetTop: 0 },
      },
      writable: true,
      configurable: true,
    });
    const { handler, cleanup } = createKeyboardScrollController(
      () => target,
      true,
    );

    handler();
    vi.advanceTimersByTime(50);
    cleanup();
    vi.advanceTimersByTime(100);

    expect(container.style.transform).toBe("");

    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it("allows multiple firings across separate debounce windows", () => {
    const container = createMockContainer();
    const { target } = createMockTarget(container);
    let viewportHeight = 500;
    Object.defineProperty(globalThis, "window", {
      value: {
        innerHeight: 800,
        get visualViewport() {
          return { height: viewportHeight, offsetTop: 0 };
        },
      },
      writable: true,
      configurable: true,
    });
    const { handler } = createKeyboardScrollController(() => target, true);

    handler();
    vi.advanceTimersByTime(100);
    expect(container.style.transform).toBe("translateY(-300px)");

    viewportHeight = 600;
    handler();
    vi.advanceTimersByTime(100);
    expect(container.style.transform).toBe("translateY(-200px)");

    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it("no-ops gracefully when target is null", () => {
    const { handler } = createKeyboardScrollController(() => null, true);
    handler();
    vi.advanceTimersByTime(300);
  });

  it("falls back to scrollIntoView when no container found", () => {
    const { target, scrollIntoView } = createMockTarget(null);
    Object.defineProperty(globalThis, "window", {
      value: {
        innerHeight: 800,
        visualViewport: { height: 500, offsetTop: 0 },
      },
      writable: true,
      configurable: true,
    });
    const { handler } = createKeyboardScrollController(() => target, true);

    handler();
    vi.advanceTimersByTime(100);

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "end",
      behavior: "smooth",
    });

    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });
});

describe("attachKeyboardScroll", () => {
  let listeners: Map<string, EventListener>;
  let mockVisualViewport: {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    height: number;
    offsetTop: number;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = new Map();
    mockVisualViewport = {
      addEventListener: vi.fn((event: string, handler: EventListener) => {
        listeners.set(event, handler);
      }),
      removeEventListener: vi.fn((event: string) => {
        listeners.delete(event);
      }),
      height: 500,
      offsetTop: 0,
    };
    Object.defineProperty(globalThis, "window", {
      value: { visualViewport: mockVisualViewport, innerHeight: 800 },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it("registers resize and scroll listeners and returns a detach function", () => {
    const { target } = createMockTarget(createMockContainer());
    const detach = attachKeyboardScroll(() => target, true);

    expect(detach).toBeTypeOf("function");
    expect(mockVisualViewport.addEventListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function),
    );
    expect(mockVisualViewport.addEventListener).toHaveBeenCalledWith(
      "scroll",
      expect.any(Function),
    );
  });

  it("detach removes listeners and resets transform", () => {
    const container = createMockContainer();
    const { target } = createMockTarget(container);
    const detach = attachKeyboardScroll(() => target, true)!;

    const handler = listeners.get("resize")!;
    handler(new Event("resize"));
    vi.advanceTimersByTime(100);
    expect(container.style.transform).toBe("translateY(-300px)");

    detach();

    expect(mockVisualViewport.removeEventListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function),
    );
    expect(container.style.transform).toBe("");
  });

  it("applies transform on resize when focused", () => {
    const container = createMockContainer();
    const { target } = createMockTarget(container);
    attachKeyboardScroll(() => target, true);

    const handler = listeners.get("resize")!;
    handler(new Event("resize"));
    vi.advanceTimersByTime(300);

    expect(container.style.transform).toBe("translateY(-300px)");
  });

  it("does not fire when not focused", () => {
    const container = createMockContainer();
    const { target } = createMockTarget(container);
    attachKeyboardScroll(() => target, false);

    const handler = listeners.get("resize")!;
    handler(new Event("resize"));
    vi.advanceTimersByTime(300);

    expect(container.style.transform).toBe("");
  });

  it("returns null when visualViewport is unavailable", () => {
    Object.defineProperty(globalThis, "window", {
      value: { visualViewport: undefined },
      writable: true,
      configurable: true,
    });
    const detach = attachKeyboardScroll(() => null, true);
    expect(detach).toBeNull();
  });
});
