import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { runValidateBlogAssetsCli } from "../src/lib/blog/validate-assets";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentDir = join(__dirname, "..", "src", "content");
const publicDir = join(__dirname, "..", "public");

runValidateBlogAssetsCli(contentDir, publicDir, {
  log: console.log.bind(console),
  error: console.error.bind(console),
  exit: process.exit.bind(process),
});
