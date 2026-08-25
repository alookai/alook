import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [barrier, teardown, resultPath, profilePath] = process.argv.slice(2);
if (!barrier || !teardown || !resultPath || !profilePath) throw new Error("missing lifecycle command fixture argument");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
while (!existsSync(barrier)) await sleep(10);

const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const { checkPorts } = await import("../../src/lib/checks.ts");
const { acquireLifecycleReservation, releaseLifecycleReservation } = await import("../../src/lib/lifecycle-lock.ts");
const { inspectServices, startServices, stopServices } = await import("../../src/lib/services.ts");
const { waitForExistingServices, waitForOwnedServices } = await import("../../src/lib/startup.ts");

let reservation;
let generationOwned = false;
let outcome = "rejected";
try {
  reservation = await acquireLifecycleReservation();
  const inspection = await inspectServices(profile);
  if (inspection.state === "none") {
    await checkPorts(profile);
    const handle = await startServices(profile, { foreground: false });
    generationOwned = true;
    await waitForOwnedServices(handle, 10_000);
    outcome = "started";
  } else if (inspection.state === "reusable") {
    await waitForExistingServices(inspection.registry, 2_000);
    outcome = "reused";
  } else {
    throw new Error(`${inspection.state}: ${inspection.detail ?? "not reusable"}`);
  }
} catch (error) {
  outcome = error instanceof Error ? error.message : String(error);
  const webLog = `${process.env.ALOOK_SELF_HOSTED_DIR}/logs/web.log`;
  if (existsSync(webLog)) outcome += `; web log: ${readFileSync(webLog, "utf8").slice(-2_000)}`;
} finally {
  if (reservation) await releaseLifecycleReservation(reservation);
}

writeFileSync(resultPath, `${JSON.stringify({ generationOwned, outcome })}\n`);
if (generationOwned) {
  while (!existsSync(teardown)) await sleep(10);
  const stopReservation = await acquireLifecycleReservation();
  try {
    const stopped = await stopServices();
    if (!stopped.stopped || stopped.errors.length > 0) throw new Error(`fixture stop failed: ${stopped.errors.join("; ")}`);
  } finally {
    await releaseLifecycleReservation(stopReservation);
  }
}
