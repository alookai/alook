import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const web = path.resolve(root, "../../web");
const requireWeb = createRequire(path.join(web, "package.json"));
const postcss = (await import("postcss")).default;
const tailwind = requireWeb("@tailwindcss/postcss");
mkdirSync(path.join(root, "public/fonts"), { recursive: true });
for (const name of [
  "dm-sans-latin.woff2",
  "caveat-latin.woff2",
  "dm-mono-latin-400.woff2",
])
  copyFileSync(
    path.join(web, "src/app/fonts", name),
    path.join(root, "public/fonts", name),
  );
copyFileSync(
  path.join(web, "public/alook.svg"),
  path.join(root, "public/alook.svg"),
);
const css =
  readFileSync(path.join(web, "src/app/globals.css"), "utf8") +
  '\n@source "../components";\n@source "../../../videos/gtm/src";\n';
const result = await postcss([
  tailwind({ base: path.join(web, "src") }),
]).process(css, {
  from: path.join(web, "src/app/globals.css"),
  to: path.join(root, "src/product.css"),
});
writeFileSync(path.join(root, "src/product.css"), result.css);

mkdirSync(path.join(root, "public/people"), { recursive: true });
for (const name of ["Lin", "Alex", "Sam", "Home", "Nina", "Omar", "Mei", "Leo", "Amara", "Diego", "Priya", "Evan"])
  copyFileSync(
    path.join(root, "src/assets/people", `${name}.png`),
    path.join(root, "public/people", `${name}.png`),
  );
