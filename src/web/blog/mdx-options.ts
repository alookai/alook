import path from "node:path";

export const blogMdxOptions: {
  remarkPlugins: string[]
  rehypePlugins: Array<string | [string, ...unknown[]]>
} = {
		remarkPlugins: ["remark-gfm"],
		rehypePlugins: [
			path.resolve(import.meta.dirname, "rehype-blog-images.mjs"),
			"rehype-slug",
			["rehype-autolink-headings", { behavior: "wrap" }],
			["rehype-external-links", { target: "_blank", rel: ["noopener", "noreferrer"] }],
			["rehype-pretty-code", { theme: { light: "vitesse-light", dark: "vitesse-dark" }, keepBackground: false }],
		],
};
