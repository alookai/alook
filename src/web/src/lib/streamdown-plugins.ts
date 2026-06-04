import { createMermaidPlugin } from "@streamdown/mermaid";
import { createMathPlugin } from "@streamdown/math";
export { cjk } from "@streamdown/cjk";

export const mermaid = createMermaidPlugin({
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
});

export const math = createMathPlugin({
  singleDollarTextMath: true,
});
