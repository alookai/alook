import path from "node:path"
import mdx from "@mdx-js/rollup"
import { defineConfig, mergeConfig } from "vitest/config"
import shared from "../../../vitest.shared"
import { blogMdxOptions } from "./mdx-options"

async function plugins(entries: (string | [string, ...unknown[]])[]) {
  return Promise.all(entries.map(async (entry) => {
    const [specifier, ...options] = typeof entry === "string" ? [entry] : entry
    const { default: plugin } = await import(String(specifier))
    return options.length ? [plugin, ...options] : plugin
  }))
}

export async function blogTestConfig() {
  const compiler = mdx({
    ...blogMdxOptions,
    remarkPlugins: await plugins(blogMdxOptions.remarkPlugins),
    rehypePlugins: await plugins(blogMdxOptions.rehypePlugins),
  })
  return mergeConfig(shared, defineConfig({
    root: import.meta.dirname,
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "../src"),
        "@blog": path.resolve(import.meta.dirname, "src"),
        "#blog-open-next-worker": path.resolve(import.meta.dirname, "../src/test-runtime/open-next-node-stub.ts"),
        "./.open-next/server-functions/default/src/web/.next/required-server-files.json": path.resolve(import.meta.dirname, "../test-runtime/next-config-stub.json"),
      },
    },
    plugins: [{
      ...compiler,
      transform: {
        filter: { id: { exclude: /[?&]raw(?:[&=]|$)/ } },
        handler: compiler.transform,
      },
    }],
    test: { testTimeout: 30_000, hookTimeout: 30_000 },
  }))
}
