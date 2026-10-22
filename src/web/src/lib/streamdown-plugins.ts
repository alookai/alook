import type { DiagramPlugin, MermaidConfig, MermaidInstance, MermaidPluginOptions } from "@streamdown/mermaid";
export { cjk, math } from "./streamdown-remark-plugins";

const options: MermaidPluginOptions = {
  config: {
    theme: "base",
    themeVariables: {
      primaryColor: "#eceae6",
      primaryTextColor: "#2d2a26",
      primaryBorderColor: "#e0ddd9",
      lineColor: "#7d7972",
      secondaryColor: "#f5f4f2",
      tertiaryColor: "#faf9f8",
      noteBkgColor: "#f5f4f2",
      noteTextColor: "#2d2a26",
      noteBorderColor: "#e0ddd9",
      textColor: "#2d2a26",
      mainBkg: "#eceae6",
      nodeBorder: "#e0ddd9",
      clusterBkg: "#f5f4f2",
      clusterBorder: "#e0ddd9",
      edgeLabelBackground: "#fdfcfb",
      fontSize: "14px",
    },
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  },
};

let engine: Promise<DiagramPlugin> | undefined;
let configuration: MermaidConfig | undefined;
let revision = 0;
let appliedRevision = -1;

const instance: MermaidInstance = {
  initialize(next) {
    configuration = next;
    revision += 1;
  },
  async render(id, source) {
    const renderConfiguration = configuration;
    const renderRevision = revision;
    engine ??= import("@streamdown/mermaid")
      .then(({ createMermaidPlugin }) => createMermaidPlugin(options))
      .catch((error: unknown) => {
        engine = undefined;
        throw error;
      });
    const plugin = await engine;
    const renderer = plugin.getMermaid();
    if (renderConfiguration && appliedRevision !== renderRevision) {
      renderer.initialize(renderConfiguration);
      appliedRevision = renderRevision;
    }
    return renderer.render(id, source);
  },
};

export const mermaid: DiagramPlugin = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid(config) {
    if (config) instance.initialize(config);
    return instance;
  },
};
