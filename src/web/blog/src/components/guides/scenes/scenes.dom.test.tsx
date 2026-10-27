import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/react-dom-harness";
import { ConnectDemo, BotsDemo } from "../mock-scenes";
import { createScene as connectScene } from "./connect";
import { createScene as botScene } from "./bots";
vi.mock("../deferred-demo", () => ({ DeferredDemo: ({ children }: { children: React.ReactNode }) => <div data-testid="scene">{children}</div> }));

describe("tutorial action sequences", () => {
  it("opens the connection dialog, copies, pastes, presses Enter and returns to Online; replay resets", () => {
    render(<ConnectDemo />);
    const root = screen.getByTestId("scene");
    const timeline = connectScene(root, vi.fn());
    try {
      timeline.time(3.9, false);
      expect(root.dataset.demoAction).toBe("copy-command");
      expect(root.querySelector("[data-copied]")).toBeVisible();
      expect(root.querySelector("[data-copy-label]")).not.toBeVisible();
      timeline.time(6, false);
      expect(root.dataset.demoAction).toBe("paste-command");
      expect(root.querySelector<HTMLElement>("[data-command-text]")!.style.visibility).toBe("inherit");
      timeline.time(7.5, false);
      expect(root.dataset.demoAction).toBe("press-enter");
      timeline.time(10, false);
      expect(root.dataset.demoAction).toBe("machine-online");
      timeline.restart().pause().time(0.1, false);
      expect(root.dataset.demoAction).toBe("open-connect");
      expect(root.querySelector("[data-copy-label]")).not.toHaveAttribute("hidden");
      expect(root.querySelector<HTMLElement>("[data-copy-label]")!.style.display).toBe("inline");
      expect(root.querySelector("[data-copied]")).not.toBeVisible();
    } finally { timeline.kill(); }
  });
  it("fills and submits Codex before starting Claude, then shows both bots", () => {
    render(<BotsDemo />);
    const root = screen.getByTestId("scene");
    const timeline = botScene(root, vi.fn());
    try {
      timeline.time(6.6, false);
      expect(root.dataset.demoAction).toBe("runtime-codex");
      expect(root.querySelectorAll('[data-option="codex"][data-selected="true"]')).toHaveLength(1);
      timeline.time(9, false);
      expect(root.dataset.demoAction).toBe("codex-created");
      timeline.time(16.2, false);
      expect(root.dataset.demoAction).toBe("runtime-claude");
      expect(root.querySelectorAll('[data-option="claude"][data-selected="true"]')).toHaveLength(1);
      timeline.time(19, false);
      expect(root.dataset.demoAction).toBe("both-created");
      timeline.restart().pause().time(0.1, false);
      expect(root.dataset.demoAction).toBe("open-create-codex");
      expect(root.querySelectorAll('[data-option][data-selected="true"]')).toHaveLength(0);
    } finally { timeline.kill(); }
  });
});
