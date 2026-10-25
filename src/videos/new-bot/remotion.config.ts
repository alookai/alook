import { Config } from "@remotion/cli/config";
import path from "node:path";
const web = path.resolve("../../web");
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.overrideWebpackConfig((config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      ...config.resolve?.alias,
      "@/hooks/community/mutations/bot-creation$": path.resolve("src/fixture-hooks.ts"),
      "@/components/avatar$": path.resolve("src/avatar-exports.ts"),
      "react-dnd$": path.resolve(".render-deps/node_modules/react-dnd"),
      "react-dnd-html5-backend$": path.resolve(".render-deps/node_modules/react-dnd-html5-backend"),
      "react-dnd-scrolling$": path.resolve(".render-deps/node_modules/react-dnd-scrolling"),
      "react-dnd-touch-backend$": path.resolve(".render-deps/node_modules/react-dnd-touch-backend"),
      "dnd-multi-backend$": path.resolve(".render-deps/node_modules/dnd-multi-backend"),
      "remark-math$": path.resolve(".render-deps/node_modules/remark-math"),
      "@": path.join(web, "src"),
      "@alook/shared$": path.resolve("../../shared/src/index.ts"),
      "@alook/shared": path.resolve("../../shared/src"),
      react: path.resolve("node_modules/react"),
      "react-dom": path.resolve("node_modules/react-dom"),
      "next/image": path.resolve("src/next-image.tsx"),
      "next/link": path.resolve("src/next-link.tsx"),
      "next/navigation": path.resolve("src/next-navigation.ts"),
    },
    modules: [
      "node_modules",
      path.resolve("node_modules"),
      path.join(web, "node_modules"),
    ],
  },
}));
