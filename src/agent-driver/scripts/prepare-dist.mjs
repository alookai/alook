import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

copyFileSync(`${repositoryRoot}LICENSE`, `${packageRoot}LICENSE`);
