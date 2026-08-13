import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armMessageReminderFromEnv, parseRemindAfter } from "./messageReminderClient";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tokenEnv(token = "vch_test_secret"): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "message-reminder-client-"));
  dirs.push(dir);
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  return { ALOOK_PROXY_URL: "http://127.0.0.1:1234/", ALOOK_PROXY_TOKEN_FILE: tokenFile };
}

describe("parseRemindAfter", () => {
  it.each([
    ["1m", 60_000],
    ["90m", 5_400_000],
    ["1h", 3_600_000],
    ["24h", 86_400_000],
  ])("parses %s", (value, expected) => expect(parseRemindAfter(value)).toBe(expected));

  it.each(["", "0m", "1s", "1.5h", "25h", "1441m", "-1m", " 1m"])("rejects %j", (value) => {
    expect(() => parseRemindAfter(value)).toThrow(/--remind-after/);
  });
});

describe("armMessageReminderFromEnv", () => {
  const input = { channel: "/s#0001/general", sentSeq: 7, remindAfterMs: 60_000 };

  it("uses the loopback PUT with the voucher and accepts an armed result", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ armed: true, dueAt: 123456 }));
    await expect(armMessageReminderFromEnv(input, tokenEnv(), fetchImpl as typeof fetch)).resolves.toEqual({
      armed: true,
      dueAt: 123456,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/__alook/local/message-reminder",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify(input),
        headers: expect.objectContaining({ authorization: "Bearer vch_test_secret" }),
      }),
    );
  });

  it("turns missing env, network, rejection, and invalid JSON into non-secret reasons", async () => {
    await expect(armMessageReminderFromEnv(input, {}, vi.fn() as typeof fetch)).resolves.toEqual({
      armed: false,
      reason: "local reminder proxy unavailable",
    });
    const secret = "vch_never_echo_this";
    const network = await armMessageReminderFromEnv(
      input,
      tokenEnv(secret),
      vi.fn(async () => { throw new Error(secret); }) as typeof fetch,
    );
    expect(network).toEqual({ armed: false, reason: "local reminder request failed" });
    expect(JSON.stringify(network)).not.toContain(secret);

    const rejected = await armMessageReminderFromEnv(
      input,
      tokenEnv(),
      vi.fn(async () => Response.json({ code: "invalid_request" }, { status: 400 })) as typeof fetch,
    );
    expect(rejected).toEqual({ armed: false, reason: "local reminder rejected (invalid_request)" });

    const invalid = await armMessageReminderFromEnv(
      input,
      tokenEnv(),
      vi.fn(async () => new Response("not json")) as typeof fetch,
    );
    expect(invalid).toEqual({ armed: false, reason: "local reminder returned an invalid response" });
  });
});
