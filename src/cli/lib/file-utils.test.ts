import { describe, it, expect } from "vitest";
import { guessContentType, contentToBuffer } from "./file-utils.js";

describe("guessContentType", () => {
  it("returns correct MIME for known extensions", () => {
    expect(guessContentType("report.pdf")).toBe("application/pdf");
    expect(guessContentType("image.png")).toBe("image/png");
    expect(guessContentType("photo.jpg")).toBe("image/jpeg");
    expect(guessContentType("photo.jpeg")).toBe("image/jpeg");
    expect(guessContentType("anim.gif")).toBe("image/gif");
    expect(guessContentType("hero.webp")).toBe("image/webp");
    expect(guessContentType("icon.svg")).toBe("image/svg+xml");
    expect(guessContentType("readme.md")).toBe("text/markdown");
    expect(guessContentType("data.json")).toBe("application/json");
    expect(guessContentType("styles.css")).toBe("application/octet-stream");
    expect(guessContentType("index.html")).toBe("text/html");
    expect(guessContentType("page.htm")).toBe("text/html");
    expect(guessContentType("app.ts")).toBe("text/typescript");
    expect(guessContentType("app.js")).toBe("text/javascript");
    expect(guessContentType("config.yaml")).toBe("text/yaml");
    expect(guessContentType("config.yml")).toBe("text/yaml");
    expect(guessContentType("data.xml")).toBe("application/xml");
    expect(guessContentType("archive.zip")).toBe("application/zip");
    expect(guessContentType("data.csv")).toBe("text/csv");
    expect(guessContentType("notes.txt")).toBe("text/plain");
  });

  it("is case-insensitive for extensions", () => {
    expect(guessContentType("image.PNG")).toBe("image/png");
    expect(guessContentType("file.PDF")).toBe("application/pdf");
  });

  it("returns octet-stream for unknown extensions", () => {
    expect(guessContentType("file.xyz")).toBe("application/octet-stream");
    expect(guessContentType("file.wasm")).toBe("application/octet-stream");
  });

  it("returns octet-stream for files without extension", () => {
    expect(guessContentType("Makefile")).toBe("application/octet-stream");
    expect(guessContentType("noext")).toBe("application/octet-stream");
  });
});

describe("contentToBuffer", () => {
  it("handles base64 string input", () => {
    const base64 = Buffer.from("hello world").toString("base64");
    const result = contentToBuffer(base64);
    expect(result.toString()).toBe("hello world");
  });

  it("handles ArrayBuffer input", () => {
    const data = new TextEncoder().encode("test data");
    const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const result = contentToBuffer(arrayBuffer);
    expect(result.toString()).toBe("test data");
  });

  it("handles Uint8Array input", () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]);
    const result = contentToBuffer(data);
    expect(result.toString()).toBe("Hello");
  });
});
