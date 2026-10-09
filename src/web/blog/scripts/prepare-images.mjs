import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
export async function prepareBlogImages(blogRoot) {
    const sources = new Set();
    const contentDir = resolve(blogRoot, "src/content");
    for (const file of (await readdir(contentDir)).filter((file) => file.endsWith(".mdx")).sort()) {
        const content = await readFile(resolve(contentDir, file), "utf8");
        const image = /\bimage:\s*["']([^"']+)["']/.exec(content);
        if (image)
            sources.add(image[1]);
        for (const match of content.matchAll(/<source[^>]+srcSet=["']([^"']+)["']/g)) {
            for (const candidate of match[1].split(",")) sources.add(candidate.trim().split(/\s+/)[0]);
        }
        for (const match of content.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)|<img[^>]+src=["']([^"']*)["'][^>]*>/g)) {
            sources.add(match[1] || match[2]);
        }
    }
    const assets = {};
    const publicRoot = resolve(blogRoot, "public");
    const outputRoot = resolve(publicRoot, "blog/_generated");
    await mkdir(outputRoot, { recursive: true });
    for (const src of [...sources].sort()) {
        if (!src.startsWith("/blog/") || src.split("/").includes(".."))
            throw new Error(`Invalid Blog image: ${src}`);
        const buffer = await readFile(resolve(publicRoot, `.${src}`));
        const metadata = await sharp(buffer).metadata();
        const { width, height } = metadata.autoOrient ?? metadata;
        if (!width || !height)
            throw new Error(`Missing Blog image dimensions: ${src}`);
        const asset = { width, height };
        if (metadata.format !== "svg" && (!metadata.pages || metadata.pages === 1)) {
            const hash = createHash("sha256").update(buffer).update("webp:85:v1").digest("hex").slice(0, 16);
            const variants = [];
            for (const size of [480, 960].filter((size) => size < width)) {
                const url = `/blog/_generated/${hash}-${size}.webp`;
                await sharp(buffer).autoOrient().resize({ width: size }).webp({ quality: 85 }).toFile(resolve(publicRoot, `.${url}`));
                variants.push(`${url} ${size}w`);
            }
            if (variants.length)
                asset.srcSet = [...variants, `${src} ${width}w`].join(", ");
        }
        assets[src] = asset;
    }
    const manifestPath = resolve(blogRoot, "src/lib/blog/image-assets.json");
    await mkdir(dirname(manifestPath), { recursive: true });
    const json = `{\n${Object.entries(assets).map(([src, value]) => `  ${JSON.stringify(src)}: ${JSON.stringify(value)}`).join(",\n")}\n}\n`;
    if (await readFile(manifestPath, "utf8").catch(() => "") !== json)
        await writeFile(manifestPath, json);
    return assets;
}
