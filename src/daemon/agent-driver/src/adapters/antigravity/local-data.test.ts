import { expect, it } from "vitest";
import { readLocalCommand } from "./local-data.js";

it("bounds local reader output and cleans its exact process after failures", async () => {
  await expect(readLocalCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024));setInterval(()=>{},1000)"], 32)).rejects.toThrow("failed");
  await expect(readLocalCommand(process.execPath, ["-e", "process.exit(1)"])).rejects.toThrow("failed");
  await expect(readLocalCommand("alook-nonexistent-data-reader", [])).rejects.toThrow("failed");
});
it("contains a hung local reader and returns successful output", async () => {
  await expect(readLocalCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"])).rejects.toThrow("timed out");
  await expect(readLocalCommand(process.execPath, ["-e", "process.stdout.write('[]')"])).resolves.toBe("[]");
});
