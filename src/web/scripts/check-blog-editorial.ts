import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { runCheckBlogEditorialCli } from "../src/lib/blog/check-editorial";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentDir = join(__dirname, "..", "src", "content");

const strict = process.argv.includes("--strict");
const reportOnly = process.argv.includes("--report");

runCheckBlogEditorialCli(contentDir, {
  log: console.log.bind(console),
  error: console.error.bind(console),
  exit: process.exit.bind(process),
}, { strict, reportOnly });
