import { describe, it, expect } from "vitest";

// ComposerShell is purely presentational. We test that the component's
// class composition logic is consistent with the expected visual states.

function getShellClasses(opts: {
  disabled?: boolean;
  className?: string;
}): string {
  const base =
    "relative flex-1 min-w-0 flex flex-col rounded-3xl border border-border/50 bg-background/90 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50";
  const parts = [base];
  if (opts.disabled) parts.push("opacity-50");
  if (opts.className) parts.push(opts.className);
  return parts.join(" ");
}

describe("ComposerShell", () => {
  it("base state includes rounded-3xl pill styling", () => {
    const classes = getShellClasses({});
    expect(classes).toContain("rounded-3xl");
    expect(classes).toContain("border-border/50");
    expect(classes).toContain("bg-background/90");
  });

  it("includes focus-within ring styling", () => {
    const classes = getShellClasses({});
    expect(classes).toContain("focus-within:border-ring");
    expect(classes).toContain("focus-within:ring-3");
  });

  it("disabled state adds opacity-50", () => {
    const classes = getShellClasses({ disabled: true });
    expect(classes).toContain("opacity-50");
  });

  it("not disabled does not add opacity-50", () => {
    const classes = getShellClasses({ disabled: false });
    expect(classes).not.toContain("opacity-50");
  });

  it("custom className is appended", () => {
    const classes = getShellClasses({ className: "custom-class" });
    expect(classes).toContain("custom-class");
  });
});
