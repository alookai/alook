import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sqlRun } from "@alook/test-utils";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const ORIGIN = new URL(APP_URL).origin;
const ids: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${APP_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  for (const id of ids) {
    sqlRun("DELETE FROM native_oauth_attempt WHERE id = ?", id);
  }
});

describe("dormant native OAuth protocol", () => {
  it("registers, reads, cancels, and proof-binds an attempt", async () => {
    const attemptId = `native_${randomUUID().replaceAll("-", "")}`;
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    ids.push(attemptId);

    const registration = await post("/api/auth/native/attempt", {
      attemptId,
      stateHash: sha256(state),
      codeChallenge: createHash("sha256")
        .update(verifier)
        .digest("base64url"),
      instanceKeyHash: sha256(`instance:${attemptId}`),
      platform: "macos",
      provider: "github",
      redirectPath: "/c/me",
    });
    expect(registration.status).toBe(200);
    await expect(registration.json()).resolves.toEqual({
      startUrl: `${ORIGIN}/auth/native/start?attempt=${attemptId}`,
    });

    const wrongProof = await post("/api/auth/native/status", {
      attemptId,
      state: randomBytes(32).toString("base64url"),
      verifier,
    });
    await expect(wrongProof.json()).resolves.toEqual({ status: "unknown" });

    const status = await post("/api/auth/native/status", {
      attemptId,
      state,
      verifier,
    });
    await expect(status.json()).resolves.toEqual({ status: "pending" });

    const cancelled = await post("/api/auth/native/cancel", {
      attemptId,
      state,
      verifier,
    });
    await expect(cancelled.json()).resolves.toEqual({ status: "cancelled" });

    const finalStatus = await post("/api/auth/native/status", {
      attemptId,
      state,
      verifier,
    });
    await expect(finalStatus.json()).resolves.toEqual({ status: "cancelled" });
  });
});
