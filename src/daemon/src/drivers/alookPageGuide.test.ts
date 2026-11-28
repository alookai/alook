import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALOOK_PAGE_GUIDE_CONTENT,
  ALOOK_PAGE_GUIDE_FILENAME,
  syncAlookPageGuide,
} from "./alookPageGuide.js";

describe("syncAlookPageGuide", () => {
  it("writes alook-page.md, skips unchanged rewrites, and updates stale copies", () => {
    const dir = mkdtempSync(join(tmpdir(), "alook-page-guide-"));
    try {
      expect(syncAlookPageGuide("")).toBe(false);
      expect(syncAlookPageGuide(dir)).toBe(true);
      const guidePath = join(dir, ALOOK_PAGE_GUIDE_FILENAME);
      expect(readFileSync(guidePath, "utf8")).toBe(ALOOK_PAGE_GUIDE_CONTENT);

      expect(syncAlookPageGuide(dir)).toBe(false);

      writeFileSync(guidePath, "stale guide", "utf8");
      expect(syncAlookPageGuide(dir)).toBe(true);
      expect(readFileSync(guidePath, "utf8")).toBe(ALOOK_PAGE_GUIDE_CONTENT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
