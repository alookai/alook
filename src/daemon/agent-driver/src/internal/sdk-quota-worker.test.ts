import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildSdkWorkerArtifact } from "../testing/sdk-worker-artifact.spec.js";
import type { SdkQuotaResult } from "./sdk-quota-worker.js";

let artifact: Awaited<ReturnType<typeof buildSdkWorkerArtifact>>;
beforeAll(async () => { artifact = await buildSdkWorkerArtifact(); });
afterAll(() => artifact?.dispose());
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function readFixture(source: string, env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "alook-sdk-quota-")); roots.push(root);
  const modulePath = join(root, "sdk.mjs");
  const calls = join(root, "calls");
  writeFileSync(modulePath, `import{appendFileSync}from'node:fs';const record=(x)=>appendFileSync(${JSON.stringify(calls)},x+'\\n');${source}`);
  const lane = new artifact.SdkWorkerLane(artifact.sdkQuotaWorker, { modulePath, cwd: root, config: {}, probe: { includeModels: false } }, { ...process.env, ...env });
  try { return { result: await lane.probe() as SdkQuotaResult, calls: readFileSync(calls, "utf8") }; }
  finally { await lane.stop({ forceAfterMs: 100 }); }
}

const copilot = (data: unknown, auth: unknown = { type: "token", host: "github.com", login: "fixture", token: "private-token", copilotUser: { copilot_plan: "pro" } }) => `
export const RuntimeConnection={forStdio:()=>({})};
export class CopilotClient{rpc={account:{getCurrentAuth:async()=>{record('auth');return{authInfo:${JSON.stringify(auth)}}},getQuota:async()=>{record('quota');return ${JSON.stringify(data)}}}};async start(){record('start')}async stop(){record('stop')}createSession(){throw Error('model sessions forbidden')}}`;
const qoder = (data: unknown) => `export const qodercliAuth=()=>({type:'local'});export const accessToken=()=>({type:'pat'});export const serviceAccount=()=>({type:'service'});export const startDaemon=async(options)=>{record('start:'+options.launchMode);return{getUsageInfo:async()=>{record('usage');return ${JSON.stringify(data)}},stop:async()=>record('stop'),createSession:()=>{throw Error('model sessions forbidden')}}};`;

describe("compiled machine quota worker in an owned process", () => {
  it("queries Copilot without a session and preserves unlimited/plan-only truth", async () => {
    const first = await readFixture(copilot({ quotaSnapshots: { premium_interactions: { remainingPercentage: 27, resetDate: "2026-12-01T00:00:00Z" }, chat: { isUnlimitedEntitlement: true, remainingPercentage: 100 } } }));
    expect(first.calls).toBe("start\nauth\nquota\nstop\n");
    expect(first.result.quota).toMatchObject({ status: "available", planName: "pro", limits: [{ usedPercent: 73, resetsAt: "2026-12-01T00:00:00.000Z" }] });
    expect(JSON.stringify(first.result)).not.toMatch(/private-token|fixture/);
    const second = await readFixture(copilot({ quotaSnapshots: { premium_interactions: { entitlementRequests: -1, remainingPercentage: 100 } } }));
    expect(second.result.quota).toMatchObject({ status: "available", planName: "pro", limits: [] });
    expect(second.result.identity).toBe(first.result.identity);
    const other = await readFixture(copilot({}, { type: "token", token: "different-account" }));
    expect(other.result.identity).not.toBe(first.result.identity);
  });

  it("refuses signed-out Copilot and malformed quota without inventing balance", async () => {
    expect((await readFixture(copilot({}, null))).result.quota).toMatchObject({ status: "error", code: "unauthorized" });
    expect((await readFixture(copilot({ quotaSnapshots: { premium_interactions: { remainingPercentage: "90" }, chat: { remainingPercentage: 101 } } }))).result.quota).toMatchObject({ status: "available", planName: "pro", limits: [] });
  });

  it("reads Qoder's account total and does not report exhausted plan credits while add-on credits remain", async () => {
    const data = { userId: "user-one", userType: "Pro", userQuota: { total: 100, used: 100 }, addOnQuota: { total: 300, remaining: 300 }, expiresAt: 1794787200000, session: { total_credits: 9 } };
    const { result, calls } = await readFixture(qoder(data));
    expect(calls).toBe("start:process\nusage\nstop\n");
    expect(result.quota).toMatchObject({ status: "available", planName: "Pro", limits: [{ usedPercent: 25, bucket: { limitId: "total-credits" } }] });
    expect(result.quota.status === "available" && result.quota.limits[0]?.resetsAt).toBeUndefined();
    expect((await readFixture(qoder({ ...data, totalUsagePercentage: 34 }))).result.quota).toMatchObject({ limits: [{ usedPercent: 34 }] });
    expect(JSON.stringify(result)).not.toContain("user-one");
  });

  it("keeps Qoder session-only, unknown-account and incompatible-unit data out of account quotas", async () => {
    expect((await readFixture(qoder({ session: { total_credits: 30 } }))).result.quota).toMatchObject({ status: "error", code: "unavailable" });
    const data = { userId: "user-one", userType: "Enterprise", userQuota: { total: 100, used: 50, unit: "credits" }, addOnQuota: { total: 100, used: 50, unit: "requests" } };
    expect((await readFixture(qoder(data))).result.quota).toMatchObject({ status: "available", planName: "Enterprise", limits: [] });
    const first = await readFixture(qoder({ userType: "Enterprise" }));
    const second = await readFixture(qoder({ userType: "Enterprise" }));
    expect(first.result.quota).toMatchObject({ status: "available", planName: "Enterprise", limits: [] });
    expect(first.result.identity).not.toBe(second.result.identity);
  });

  it("cleans a failed SDK query and exposes only a safe error", async () => {
    const source = copilot({}).replace("record('quota');return {}", "record('quota');throw Error('secret-account-token')");
    const { result, calls } = await readFixture(source);
    expect(result.quota).toMatchObject({ status: "error", code: "provider_error" });
    expect(calls).toBe("start\nauth\nquota\nstop\n");
    expect(JSON.stringify(result)).not.toContain("secret-account-token");
  });
});
