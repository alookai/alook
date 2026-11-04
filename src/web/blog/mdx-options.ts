import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const blogMdxOptions: {
  remarkPlugins: string[]
  rehypePlugins: Array<string | [string, ...unknown[]]>
} = {
		remarkPlugins: [require.resolve("remark-gfm")],
		rehypePlugins: [
			path.resolve(import.meta.dirname, "rehype-blog-images.mjs"),
			"rehype-slug",
			["rehype-autolink-headings", { behavior: "wrap" }],
			["rehype-external-links", { target: "_blank", rel: ["noopener", "noreferrer"] }],
			["rehype-pretty-code", { theme: { light: "vitesse-light", dark: "vitesse-dark" }, keepBackground: false }],
		],
};
