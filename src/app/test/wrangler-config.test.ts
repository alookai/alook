import { describe, it, expect } from "vitest";

// Test the setVar logic directly (extracted for testability)
function setVar(content: string, key: string, value: string): string {
  const pattern = new RegExp(`${key}\\s*=\\s*"[^"]*"`);
  if (pattern.test(content)) {
    return content.replace(pattern, `${key} = "${value}"`);
  }
  if (content.includes("[vars]")) {
    return content.replace(/\[vars\]/, `[vars]\n${key} = "${value}"`);
  }
  return content + `\n[vars]\n${key} = "${value}"\n`;
}

function setDevPort(content: string, port: number): string {
  if (content.includes("[dev]")) {
    return content.replace(/(\[dev\][^\[]*?)port\s*=\s*\d+/, `$1port = ${port}`);
  }
  return content + `\n[dev]\nport = ${port}\n`;
}

describe("wrangler-config", () => {
  describe("setVar", () => {
    it("replaces existing var value", () => {
      const content = `[vars]\nDEV_WS_DO_URL = "http://localhost:8789"`;
      const result = setVar(content, "DEV_WS_DO_URL", "http://localhost:9999");
      expect(result).toContain(`DEV_WS_DO_URL = "http://localhost:9999"`);
    });

    it("adds var under existing [vars] section", () => {
      const content = `name = "web"\n[vars]\nFOO = "bar"`;
      const result = setVar(content, "NEW_KEY", "new_value");
      expect(result).toContain(`[vars]\nNEW_KEY = "new_value"`);
      expect(result).toContain(`FOO = "bar"`);
    });

    it("creates [vars] section when missing", () => {
      const content = `name = "web"\n[dev]\nport = 3000`;
      const result = setVar(content, "DEV_WS_DO_URL", "http://localhost:8789");
      expect(result).toContain(`[vars]`);
      expect(result).toContain(`DEV_WS_DO_URL = "http://localhost:8789"`);
    });

    it("handles empty content", () => {
      const result = setVar("", "KEY", "value");
      expect(result).toContain(`[vars]\nKEY = "value"`);
    });
  });

  describe("setDevPort", () => {
    it("replaces port in existing [dev] section", () => {
      const content = `name = "web"\n[dev]\nport = 3000`;
      const result = setDevPort(content, 4000);
      expect(result).toContain("port = 4000");
      expect(result).not.toContain("port = 3000");
    });

    it("appends [dev] section when missing", () => {
      const content = `name = "web"`;
      const result = setDevPort(content, 3000);
      expect(result).toContain("[dev]");
      expect(result).toContain("port = 3000");
    });
  });
});
