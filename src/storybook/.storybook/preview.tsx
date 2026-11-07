import type { Preview } from "@storybook/nextjs-vite"
import { mswLoader } from "msw-storybook-addon/csf3"
import { previewNetworkHandlers, startPreviewNetwork } from "../preview/network"
import { MINIMAL_VIEWPORTS } from "storybook/viewport"
import { installDocumentAppearance, installStoryDocumentAppearance, WorkbenchFrame } from "../preview/workbench-frame"
import "../preview/styles.css"

const preview: Preview = {
  beforeAll: installDocumentAppearance,
  beforeEach: (context) => installStoryDocumentAppearance(context.title),
  loaders: [mswLoader(startPreviewNetwork)],
  globalTypes: {
    theme: { description: "Product theme", toolbar: { title: "Theme", icon: "circlehollow", items: ["light", "dark"], dynamicTitle: true } },
  },
  initialGlobals: { theme: "light" },
  parameters: {
    msw: previewNetworkHandlers,
    nextjs: { appDirectory: true },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    viewport: { options: MINIMAL_VIEWPORTS },
    options: { storySort: { order: ["Catalog", "Web", ["Foundations", "Business", "Pages"], "Blog"] } },
    a11y: { test: "todo" },
  },
  decorators: [(Story, context) => <WorkbenchFrame mode={context.globals.theme === "dark" ? "dark" : "light"} blog={context.title.startsWith("Blog/")}><Story /></WorkbenchFrame>],
}

export default preview
