import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test/react-dom-harness";
import { ConnectDemo, BotsDemo } from "../mock-scenes";
import { createScene as connectScene } from "./connect";
import { ServerDemo } from "../server-demo";
import { createScene as serverScene } from "./server";
import { createScene as botScene } from "./bots";
vi.mock("../deferred-demo", () => ({ DeferredDemo: ({ children }: { children: React.ReactNode }) => <div data-testid="scene">{children}</div> }));
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

describe("tutorial action sequences", () => {
  it("uses the landing shell and real pairing controls before pasting and returning online", () => {
    render(<ConnectDemo />);
    const root = screen.getByTestId("scene");
    expect(root.querySelectorAll('[data-testid="landing-motion-stage"]')).toHaveLength(3);
    expect(root.querySelector('[data-copy]')).toHaveAttribute("aria-label", "Copy command");
    const timeline = connectScene(root, vi.fn());
    try {
      act(() => { timeline.time(6.6, false); });
      expect(root.dataset.demoAction).toBe("copy-command");
      act(() => { timeline.time(9, false); });
      expect(root.dataset.demoAction).toBe("paste-command");
      expect(root.querySelector<HTMLElement>("[data-command-text]")!.style.display).toBe("inline");
      act(() => { timeline.time(10.8, false); });
      expect(root.querySelector<HTMLElement>("[data-terminal-newline]")!.style.display).toBe("inline");
      act(() => { timeline.time(13, false); });
      expect(root.dataset.demoAction).toBe("machine-online");
      act(() => { timeline.restart().pause().time(0.1, false); });
      expect(root.dataset.demoAction).toBe("open-connect");
      expect(root.querySelector<HTMLElement>("[data-command-text]")!.style.display).toBe("none");
      expect(root.querySelector<HTMLElement>("[data-terminal-newline]")!.style.display).toBe("none");
      expect(root.querySelector<HTMLElement>("[data-demo-pointer]")!.style.visibility).not.toBe("hidden");
    } finally { timeline.kill(); }
  });
  it.each([ ["codex", "Milo"], ["claude", "Nova"] ] as const)("independently creates %s and resets its form on replay", (runtime, name) => {
    render(<BotsDemo runtime={runtime} />);
    const root = screen.getByTestId("scene");
    const forms = root.querySelectorAll('[data-bot-form]');
    expect(forms).toHaveLength(1);
    expect(root.querySelectorAll('[data-demo-frame]')).toHaveLength(3);
    const timeline = botScene(root, vi.fn());
    try {
      act(() => { timeline.time(14, false); });
      expect(root.dataset.demoAction).toBe(`${runtime}-created`);
      expect(forms[0].querySelector('input[placeholder="Name your bot"]')).toHaveValue(name);
      expect(forms[0].querySelector(`input[value="${runtime}"]`)).toBeChecked();
      act(() => { timeline.restart().pause().time(0.1, false); });
      expect(root.dataset.demoAction).toBe(`open-create-${runtime}`);
      expect(forms[0].querySelector('input[placeholder="Name your bot"]')).toHaveValue("");
      expect(forms[0].querySelector('input[value="codex"]')).toBeChecked();
    } finally { timeline.kill(); }
  });
});


describe("server invitation walkthrough", () => {
  it("creates Studio, directly invites both bots, waits for membership and resets", () => {
    render(<ServerDemo />);
    const root = screen.getByTestId("scene");
    const timeline = serverScene(root, vi.fn());
    try {
      act(() => { timeline.time(7.4, false); });
      expect(root.querySelector<HTMLInputElement>('[data-testid="community-create-server-name"]')!.value).toBe("Studio");
      act(() => { timeline.time(14.5, false); });
      expect(root.querySelector('[data-invite-recipient="milo"] button')!.textContent).toBe("Invited");
      expect(root.querySelector('[data-invite-recipient="nova"] button')!.textContent).toBe("Invite");
      act(() => { timeline.time(17, false); });
      expect(root.querySelector('[data-invite-recipient="nova"] button')!.textContent).toBe("Invited");
      expect(root.dataset.demoAction).toBe("invitations-sent");
      act(() => { timeline.time(24, false); });
      expect(root.dataset.demoAction).toBe("both-joined");
      expect(root.querySelector('[data-members-result]')!.textContent).toContain("Milo");
      expect(root.querySelector('[data-members-result]')!.textContent).toContain("Nova");
      act(() => { timeline.restart().pause().time(0.1, false); });
      expect(root.querySelector<HTMLInputElement>('[data-testid="community-create-server-name"]')!.value).toBe("");
      expect(root.querySelector('[data-invite-recipient="milo"] button')!.textContent).toBe("Invite");
      expect(root.querySelector('[data-invite-recipient="nova"] button')!.textContent).toBe("Invite");
    } finally { timeline.kill(); }
  });
});
