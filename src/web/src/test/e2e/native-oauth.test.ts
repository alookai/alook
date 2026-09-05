import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sqlQuery, sqlRun } from "@alook/test-utils";

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
  it("accepts start and callback through the real zone ingress", async () => {
    const missingAttempt = `native_${randomUUID().replaceAll("-", "")}`;
    const [start, callback] = await Promise.all([
      fetch(`${APP_URL}/auth/native/start?attempt=${missingAttempt}`, {
        redirect: "manual",
      }),
      fetch(
        `${APP_URL}/auth/native/callback?attempt=${missingAttempt}&kind=signin`,
        { redirect: "manual" },
      ),
    ]);

    expect(start.status).toBe(410);
    expect(callback.status).toBe(410);
  });

  it("leaves exactly one live attempt after overlapping registrations", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const attemptIds = [`native_a_${suffix}`, `native_b_${suffix}`];
    const instanceKeyHash = sha256(`instance:${suffix}`);
    ids.push(...attemptIds);
    const registrations = attemptIds.map((attemptId) => ({
      attemptId,
      stateHash: sha256(`state:${attemptId}`),
      codeChallenge: createHash("sha256")
        .update(`verifier:${attemptId}`)
        .digest("base64url"),
      instanceKeyHash,
      platform: "macos",
      provider: "github",
      redirectPath: "/c/me",
    }));

    const settled = await Promise.allSettled(
      registrations.map((body) => post("/api/auth/native/attempt", body)),
    );
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    const responses = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    const rows = sqlQuery<{ id: string; status: string }>(
      `SELECT id, status FROM native_oauth_attempt
        WHERE instance_key_hash = ? ORDER BY id`,
      instanceKeyHash,
    );
    expect(rows.map((row) => row.id)).toEqual([...attemptIds].sort());
    expect(rows.filter((row) =>
      ["pending", "opened", "ready", "exchanging"].includes(row.status),
    )).toHaveLength(1);
    expect(rows.filter((row) => row.status === "replaced")).toHaveLength(1);
  });

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
