import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { blogMdxOptions } from "../../web/blog/mdx-options.ts"

const here = dirname(fileURLToPath(import.meta.url))
const blogRequire = createRequire(resolve(here, "../../web/blog/mdx-options.ts"))

async function loadPlugin(entry: string | [string, ...unknown[]]) {
  const specifier = Array.isArray(entry) ? entry[0] : entry
  const imported: { default: unknown } = await import(pathToFileURL(blogRequire.resolve(specifier)).href)
  return Array.isArray(entry) ? [imported.default, ...entry.slice(1)] : imported.default
}

export async function mdxLoaderOptions(options: { mdxCompileOptions?: Record<string, unknown> }) {
  return {
    ...options,
    mdxCompileOptions: {
      ...options.mdxCompileOptions,
      providerImportSource: resolve(here, "../../web/blog/mdx-components.tsx"),
      remarkPlugins: await Promise.all(blogMdxOptions.remarkPlugins.map(loadPlugin)),
      rehypePlugins: await Promise.all(blogMdxOptions.rehypePlugins.map(loadPlugin)),
    },
  }
}
