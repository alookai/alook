import { describe, expect, it } from "vitest";
import { useMDXComponents } from "../mdx-components";

describe("useMDXComponents", () => {
  it("suppresses MDX h1 so the page template owns the single H1", () => {
    const components = useMDXComponents({});
    expect(components.h1).toBeTypeOf("function");
    expect(components.h1?.({} as never)).toBeNull();
  });

  it("preserves passed-through components", () => {
    const p = () => "paragraph";
    const components = useMDXComponents({ p });
    expect(components.p).toBe(p);
  });
});
