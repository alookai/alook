import { createMermaidPlugin } from "@streamdown/mermaid";
export { cjk } from "@streamdown/cjk";

export const mermaid = createMermaidPlugin({
  config: {
    theme: "base",
    themeVariables: {
      primaryColor: "oklch(0.93 0.008 80)",
      primaryTextColor: "oklch(0.18 0.01 60)",
      primaryBorderColor: "oklch(0.915 0.008 80)",
      lineColor: "oklch(0.52 0.01 60)",
      secondaryColor: "oklch(0.97 0.005 80)",
      tertiaryColor: "oklch(0.985 0.005 80)",
      noteBkgColor: "oklch(0.97 0.005 80)",
      noteTextColor: "oklch(0.18 0.01 60)",
      noteBorderColor: "oklch(0.915 0.008 80)",
      textColor: "oklch(0.18 0.01 60)",
      mainBkg: "oklch(0.93 0.008 80)",
      nodeBorder: "oklch(0.915 0.008 80)",
      clusterBkg: "oklch(0.97 0.005 80)",
      clusterBorder: "oklch(0.915 0.008 80)",
      edgeLabelBackground: "oklch(0.995 0.003 80)",
      fontSize: "14px",
    },
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  },
});
