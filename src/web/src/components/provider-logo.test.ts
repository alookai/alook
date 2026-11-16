import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpenAILogo, ProviderLogo } from "./provider-logo";

describe("ProviderLogo", () => {
  it.each(["codex", "codex-app", "codex-cli"])("uses the Codex product mark for %s", (provider) => {
    const markup = renderToStaticMarkup(createElement(ProviderLogo, { provider, className: "size-5" }));
    expect(markup).toContain('data-provider-logo="codex"');
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('class="size-5"');
    expect(markup).toContain('fill="currentColor"');
    expect(markup).not.toContain('data-provider-logo="openai"');
  });

  it("retains the separate OpenAI identity for sign-in", () => {
    expect(renderToStaticMarkup(createElement(OpenAILogo))).toContain('data-provider-logo="openai"');
  });

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
