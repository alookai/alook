import type { StorybookConfig } from "@storybook/nextjs-vite"
import { dirname, resolve } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(resolve(here, "../../web/package.json"))
const packagePath = (name: string) => dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`)))

const config: StorybookConfig = {
  stories: ["../stories/**/*.stories.@(ts|tsx)"],
  addons: [packagePath("@storybook/addon-docs"), packagePath("@storybook/addon-a11y"), "msw-storybook-addon", resolve(here, "blog-mdx-preset.ts"), resolve(here, "preview-server-preset.ts")],
  framework: {
    name: packagePath("@storybook/nextjs-vite"),
    options: { nextConfigPath: resolve(here, "../next.config.mjs") },
  },
  staticDirs: [{ from: "../../web/public", to: "/" }, { from: "../../web/blog/public/blog", to: "/blog" }, { from: "../public", to: "/" }],
  core: { disableTelemetry: true },
  async viteFinal(config) {
    const aliases = Array.isArray(config.resolve?.alias) ? config.resolve.alias : Object.entries(config.resolve?.alias ?? {}).map(([find, replacement]) => ({ find, replacement }))
    config.resolve = {
      ...config.resolve,
      alias: [{ find: "@", replacement: resolve(here, "../../web/src") }, { find: "@blog", replacement: resolve(here, "../../web/blog/src") }, ...aliases],
      dedupe: [...new Set([...(config.resolve?.dedupe ?? []), "react", "react-dom", "@tanstack/react-query", "@tanstack/react-store", "@tanstack/store"])],
    }
    config.css = { ...config.css, postcss: resolve(here, "..") }
    config.optimizeDeps = {
      ...config.optimizeDeps,
      include: [...(config.optimizeDeps?.include ?? []), "@alook/web > @tanstack/react-store > use-sync-external-store/shim/with-selector.js"],
    }
    config.plugins = [...(config.plugins ?? []), {
      name: "vite-plugin-alook-storybook-telemetry",
      enforce: "post",
      config: () => ({
        resolve: { alias: [{ find: /^@opentelemetry\/api$/, replacement: webRequire.resolve("@opentelemetry/api") }] },
        define: { "process.env.NEXT_PUBLIC_APP_URL": JSON.stringify("") },
      }),

    }]
    return config
  },
}

export default config
