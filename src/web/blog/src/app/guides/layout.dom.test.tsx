import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/test/react-dom-harness";
import GuidesLayout from "./layout";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: ComponentProps<"a">) => (
    <a data-next-link="true" href={href} {...props}>{children}</a>
  ),
}));
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

describe("Guides layout", () => {
  it("renders its breadcrumb and children with navigation across the correct zone boundaries", () => {
    render(<GuidesLayout><h1>Guide directory</h1></GuidesLayout>);

    expect(within(screen.getByRole("main")).getByRole("heading", { name: "Guide directory" })).toBeVisible();
    const header = within(screen.getByRole("navigation", { name: "", exact: true }));
    const breadcrumb = header.getByRole("link", { name: "Guides", exact: true });
    expect(breadcrumb).toHaveAttribute("href", "/guides");
    expect(breadcrumb).toHaveAttribute("data-next-link", "true");
    expect(screen.getByRole("button", { name: /^Switch to (?:dark|light) theme$/ })).toBeVisible();
    const footer = within(screen.getByRole("contentinfo"));
    for (const home of [
      header.getByRole("link", { name: /^Alook(?:\s*Alook)?$/ }),
      footer.getByRole("link", { name: "Alook home", exact: true }),
    ]) {
      expect(home).toHaveAttribute("href", "/");
      expect(home).not.toHaveAttribute("data-next-link");
    }

    const navigation = within(footer.getByRole("navigation", { name: "Footer navigation" }));
    expect(navigation.getAllByRole("link").map((link) => link.getAttribute("href")))
      .toEqual(["/download", "/pricing", "/blog", "/contact", "/tutorials"]);
    expect(navigation.getByRole("link", { name: "Blog", exact: true })).toHaveAttribute("data-next-link", "true");
    for (const name of ["Download", "Pricing", "Contact"]) {
      expect(navigation.getByRole("link", { name, exact: true })).not.toHaveAttribute("data-next-link");
    }
    expect(navigation.getByRole("link", { name: "Tutorials", exact: true })).toHaveAttribute("data-next-link", "true");
  });
});
