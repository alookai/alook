import { copyFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function prepareLogo() {
  mkdirSync(new URL("../src/generated/", import.meta.url), { recursive: true });
  copyFileSync(
    new URL("../../logo/src/Composition.tsx", import.meta.url),
    new URL("../src/generated/official-logo-animation.tsx", import.meta.url),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) prepareLogo();
