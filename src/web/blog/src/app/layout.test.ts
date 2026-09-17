import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/analytics-consent", () => ({
  AnalyticsConsent: "analytics-consent",
}));

vi.mock("@/components/theme-color-sync", () => ({
  ThemeColorSync: "theme-color-sync",
}));

vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: "theme-provider",
}));

vi.mock("@/app/fonts", () => ({
  caveat: { variable: "caveat" },
  dmMono: { variable: "dm-mono" },
  dmSans: { variable: "dm-sans" },
  instrumentSerif: { variable: "instrument-serif" },
  literata: { variable: "literata" },
  vt323: { variable: "vt323" },
}));

const seo = vi.hoisted(() => ({
  metadata: { title: "Alook" },
  structuredData: { "@type": "Organization" },
  viewport: { width: "device-width" },
}));

vi.mock("@/lib/seo/site-metadata", () => ({
  siteMetadata: seo.metadata,
  siteStructuredData: seo.structuredData,
  siteViewport: seo.viewport,
}));

import BlogRootLayout, { metadata, viewport } from "./layout";

describe("BlogRootLayout", () => {
  it("renders the shared analytics consent control after blog content", () => {
    const child = createElement("main", null, "Post");
    const layout = BlogRootLayout({ children: child });

    expect(metadata).toBe(seo.metadata);
    expect(viewport).toBe(seo.viewport);
    expect(layout.type).toBe("html");

    const body = layout.props.children[1];
    const provider = body.props.children[1];

    expect(provider.type).toBe("theme-provider");
    expect(provider.props.children).toEqual([
      expect.objectContaining({ type: "theme-color-sync" }),
      child,
      expect.objectContaining({ type: "analytics-consent" }),
    ]);
  });
});
