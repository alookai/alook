import { render } from "@/test/react-dom-harness";
import { describe, expect, it, vi } from "vitest";
import { BlogFooter } from "./blog-footer";
import { PublicLayout } from "@/components/public-layout";

vi.mock("@/components/github-outbound-link", () => ({
  GithubOutboundLink: ({ children }: { children: React.ReactNode }) => <a href="https://github.com/alookai/alook">{children}</a>,
}));

describe("Blog footer", () => {
  it("keeps footer navigation outside main and preserves document links across Workers", () => {
    const { container: doc } = render(<PublicLayout zone="blog" footer={<BlogFooter />}>Article</PublicLayout>);
    expect(doc.querySelectorAll("footer")).toHaveLength(1);
    expect(doc.querySelector("main footer")).toBeNull();
    expect(doc.querySelector("main")?.nextElementSibling?.tagName).toBe("FOOTER");
    expect([...doc.querySelectorAll("footer nav a")].map((a) => a.getAttribute("href"))).toEqual(["/templates", "/blog", "/llms.txt", "/privacy"]);
    expect(doc.querySelectorAll(".blog-footer-socials a")).toHaveLength(3);
    expect(doc.querySelector(".blog-footer-slogan")?.textContent).toContain("Share your agents");
  });
});
