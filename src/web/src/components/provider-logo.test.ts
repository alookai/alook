import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderLogo } from "./provider-logo";

describe("ProviderLogo", () => {
  it("renders the official Grok logomark for the grok runtime", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderLogo, { provider: "grok", className: "size-6" }),
    );

    expect(markup).toContain('data-provider-logo="grok"');
    expect(markup).toContain('viewBox="0 0 1024 1024"');
    expect(markup).toContain('class="size-6"');
    expect(markup.match(/class="fill-current"/g)).toHaveLength(2);
    expect(markup.match(/<path/g)).toHaveLength(2);
  });
});
