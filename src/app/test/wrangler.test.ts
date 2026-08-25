import { describe, expect, it } from "vitest";
import { wranglerProcess } from "../src/lib/wrangler.js";

describe("wranglerProcess", () => {
  it("owns the real CLI root instead of the non-forwarding public bin wrapper", () => {
    const command = wranglerProcess(["dev", "--local"]);
    expect(command.command).toBe(process.execPath);
    expect(command.args[0]).toBe("--no-warnings");
    expect(command.args[1]).toMatch(/wrangler-dist[\\/]cli\.js$/);
    expect(command.args.slice(2)).toEqual(["dev", "--local"]);
  });
});
