import { createElement, cloneElement, type PropsWithChildren, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/react-dom-harness";

const mocks = vi.hoisted(() => ({
  clipboardWrite: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({
  cliCmd: () => "npx @alook/cli",
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, size: _size, ...props }: PropsWithChildren<Record<string, unknown>>) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => createElement("div", {}, children),
  TooltipTrigger: ({ children, render: trigger }:
    PropsWithChildren<{ render?: ReactElement }>) =>
    cloneElement(trigger ?? createElement("div"), {}, children),
  TooltipContent: ({ children }: PropsWithChildren) => createElement("span", {}, children),
}));

import { ConnectMachineSteps } from "./connect-machine-steps";

describe("ConnectMachineSteps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { clipboard: { writeText: mocks.clipboardWrite } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the supported terminal registration path available", () => {
    render(createElement(ConnectMachineSteps, {
      generatedToken: "machine_token",
      generatingToken: false,
      onGenerateToken: vi.fn(),
      registered: false,
      daemonOnline: false,
    }));

    const command = "npx @alook/cli register --token machine_token";
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText(command)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Copy Command" }));
    expect(mocks.clipboardWrite).toHaveBeenCalledWith(command);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Copied to clipboard");
  });
});
