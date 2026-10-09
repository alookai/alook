import { readFileSync } from "node:fs";

export default function rehypeBlogImages() {
  const assets = JSON.parse(readFileSync(new URL("./src/lib/blog/image-assets.json", import.meta.url), "utf8"));
  return (tree) => {
    let first = true;
    function visit(node) {
      const jsx = node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";
      const tag = jsx ? node.name : node.tagName;
      if (tag === "img" || tag === "source") {
        const properties = jsx ? Object.fromEntries(node.attributes.filter((a) => a.type === "mdxJsxAttribute").map((a) => [a.name, a.value])) : node.properties;
        const src = tag === "img" ? properties.src : properties.srcSet?.split?.(/[,\s]/)[0];
        const asset = assets[src];
        if (!asset) throw new Error(`Unprepared Blog image: ${src}`);
        const values = { width: asset.width, height: asset.height };
        if (tag === "img") {
          Object.assign(values, {
            loading: first ? "eager" : "lazy", decoding: "async",
            ...(asset.srcSet ? { srcSet: asset.srcSet, sizes: "(max-width: 768px) calc(100vw - 48px), 720px" } : {}),
          });
          first = false;
        }
        if (jsx) {
          node.attributes = node.attributes.filter((a) => !(a.name in values));
          node.attributes.push(...Object.entries(values).map(([name, value]) => ({ type: "mdxJsxAttribute", name, value: String(value) })));
        } else Object.assign(node.properties, values);
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(tree);
  };
}
