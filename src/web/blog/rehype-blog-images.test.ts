import { describe, expect, it } from "vitest";
import rehypeBlogImages from "./rehype-blog-images.mjs";

const image = (src = "/blog/ai-agent-team/hero.webp") => ({ type: "element", tagName: "img", properties: { src, alt: "Diagram" } as Record<string, unknown> });
describe("Blog image transform", () => {
  it("reserves true size and keeps first image eager, later images lazy on each article", () => {
    const transform = rehypeBlogImages();
    for (let index = 0; index < 2; index++) {
      const first = image(), second = image();
      transform({ children: [first, { children: [second] }] });
      expect(first.properties).toMatchObject({ width: 1200, height: 800, loading: "eager", alt: "Diagram" });
      expect(second.properties.loading).toBe("lazy");
      expect(first.properties.srcSet).toContain("480w");
    }
  });
  it("rejects assets that were not prepared", () => expect(() => rehypeBlogImages()({ children: [image("/missing.webp")] })).toThrow("Unprepared"));
  it("preserves picture art direction and adds dimensions to JSX sources and images", () => {
    const attr = (name: string, value: string) => ({ type: "mdxJsxAttribute", name, value });
    const source = { type: "mdxJsxFlowElement", name: "source", attributes: [attr("srcSet", "/blog/introducing-alook/local-first-mobile.webp"), attr("media", "(max-width: 640px)")] };
    const img = { type: "mdxJsxFlowElement", name: "img", attributes: [attr("src", "/blog/introducing-alook/local-first.png"), attr("alt", "")] };
    rehypeBlogImages()({ children: [{ type: "mdxJsxFlowElement", name: "picture", attributes: [], children: [source, img] }] });
    expect(source.attributes).toContainEqual(attr("media", "(max-width: 640px)"));
    expect(source.attributes.some(a => a.name === "height" && Number(a.value) > 0)).toBe(true);
    expect(img.attributes).toContainEqual(attr("loading", "eager"));
    expect(img.attributes).toContainEqual(attr("alt", ""));
  });

});
