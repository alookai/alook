import webConfig from "../web/eslint.config.mjs"

const config = [
  ...webConfig.map((config) => config.languageOptions?.parserOptions?.project ? {
    ...config,
    languageOptions: { ...config.languageOptions, parserOptions: { ...config.languageOptions.parserOptions, project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname } },
  } : config),
  { ignores: ["storybook-static/**", "public/mockServiceWorker.js"] },
  { settings: { next: { rootDir: "../web/" } } },
  { rules: { "tailwind-canonical-classes/tailwind-canonical-classes": ["warn", { cssPath: "../web/src/app/globals.css" }] } },
]

export default config
