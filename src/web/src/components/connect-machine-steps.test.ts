import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", props, children),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => React.createElement("div", {}, children),
  TooltipTrigger: ({ children, render }: React.PropsWithChildren<{ render?: React.ReactElement }>) =>
    React.cloneElement(render ?? React.createElement("div"), {}, children),
  TooltipContent: ({ children }: React.PropsWithChildren) => React.createElement("span", {}, children),
}));

import { ConnectMachineSteps } from "./connect-machine-steps";

describe("ConnectMachineSteps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { clipboard: { writeText: mocks.clipboardWrite } });
  });

  it("keeps the supported terminal registration path available", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(ConnectMachineSteps, {
        generatedToken: "machine_token",
        generatingToken: false,
        onGenerateToken: vi.fn(),
        registered: false,
        daemonOnline: false,
      }));
    });

    expect(renderer.root.findAllByType("button")).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("npx @alook/cli register --token machine_token");

    act(() => {
      renderer.root.findByType("button").props.onClick();
    });
    expect(mocks.clipboardWrite).toHaveBeenCalledWith("npx @alook/cli register --token machine_token");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Copied to clipboard");
  });
});
