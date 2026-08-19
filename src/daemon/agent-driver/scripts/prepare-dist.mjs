import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

copyFileSync(resolve("../../../LICENSE"), resolve("LICENSE"));
