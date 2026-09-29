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
      "@": path.join(web, "src"),
      "@alook/shared": path.resolve("../../shared/src/index.ts"),
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
