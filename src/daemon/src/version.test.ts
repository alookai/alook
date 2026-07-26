import { describe, it, expect } from "vitest";
import { getDaemonClientInfo, readDaemonVersion } from "./version";

describe("getDaemonClientInfo", () => {
  it("returns the daemon's real name and package.json version", () => {
    const info = getDaemonClientInfo();
    expect(info.name).toBe("alook-daemon");
    // Version is whatever `readDaemonVersion()` reports at test time — we
    // don't assert a specific string (that would rot at every version bump),
    // only that the two shapes agree.
    expect(info.version).toBe(readDaemonVersion());
    expect(info.version.length).toBeGreaterThan(0);
  });
});
