import { SERVICE_NAMES, type ServiceName } from "./constants.js";
import {
  handleMatchesRegistry,
  markServicesReady,
  terminateOwnedHandle,
  type OwnedServiceHandle,
} from "./services.js";
import type { ServiceRegistry } from "./pid.js";
import { readRegistry } from "./pid.js";
import {
  acquireLifecycleReservation,
  releaseLifecycleReservation,
  type LifecycleReservation,
} from "./lifecycle-lock.js";

type ProbeResult = { state: "ready" } | { state: "unavailable" } | { state: "unhealthy"; status: number };

async function probe(url: string, deadline: number): Promise<ProbeResult> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { state: "unavailable" };
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, remaining))),
    });
    return response.status === 200 ? { state: "ready" } : { state: "unhealthy", status: response.status };
  } catch {
    return { state: "unavailable" };
  }
}

async function pollAllServices(
  registry: ServiceRegistry,
  timeoutMs: number,
  failOnHttpError = false,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set<ServiceName>(SERVICE_NAMES);
  let nextProgressAt = Date.now() + 10_000;
  while (Date.now() < deadline && pending.size > 0) {
    await Promise.all([...pending].map(async (name) => {
      const entry = registry.services[name];
      if (!entry) return;
      const result = await probe(entry.healthUrl, deadline);
      if (result.state === "ready") pending.delete(name);
      if (failOnHttpError && result.state === "unhealthy") {
        throw new Error(
          `${name} health returned HTTP ${result.status} for ready service generation; log ${entry.logPath}\n` +
          "Run 'npx @alook/app stop' before retrying.",
        );
      }
    }));
    if (pending.size === 0) return;
    if (Date.now() >= nextProgressAt) {
      process.stdout.write(`  still starting: ${[...pending].join(", ")}\n`);
      nextProgressAt += 10_000;
    }
    const sleepMs = Math.min(500, deadline - Date.now());
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  const facts = [...pending].map((name) => {
    const entry = registry.services[name];
    return `${name} (${entry?.healthUrl ?? "missing health URL"}; log ${entry?.logPath ?? "missing"})`;
  });
  throw new Error(
    `services did not become ready within ${Math.max(1, Math.ceil(timeoutMs / 1000))} seconds: ${facts.join(", ")}\n` +
    "Run 'npx @alook/app stop' before retrying.",
  );
}

export async function waitForExistingServices(registry: ServiceRegistry, timeoutMs = 90_000): Promise<void> {
  await pollAllServices(registry, timeoutMs, true);
}

export async function waitForOwnedServices(handle: OwnedServiceHandle, timeoutMs = 90_000): Promise<void> {
  const childFailures = SERVICE_NAMES.flatMap((name) => {
    const supervisor = handle.supervisors[name];
    if (!supervisor) return [];
    return [supervisor.failure.then((status) => {
      throw new Error(
        `${name} exited before readiness (code=${String(status.exitCode)} signal=${String(status.exitSignal)}): ` +
        `${status.error ?? "no child error"}; log ${handle.registry.services[name]?.logPath ?? "missing"}\n` +
        "Run 'npx @alook/app stop' before retrying.",
      );
    })];
  });

  try {
    await Promise.race([pollAllServices(handle.registry, timeoutMs), ...childFailures]);
    markServicesReady(handle);
  } catch (error) {
    try {
      await terminateOwnedHandle(handle);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "service startup and owned cleanup both failed");
    }
    throw error;
  }
}

export interface OwnedSignalCleanup {
  markReservationReleased(): void;
  dispose(): void;
}

export function installOwnedSignalCleanup(
  handle: OwnedServiceHandle,
  initialReservation: LifecycleReservation,
): OwnedSignalCleanup {
  let cleaning = false;
  let reservationReleased = false;
  const cleanup = async (exitCode: number) => {
    if (cleaning) return;
    cleaning = true;
    let reservation: LifecycleReservation | undefined;
    try {
      reservation = reservationReleased
        ? await acquireLifecycleReservation()
        : initialReservation;
      const current = readRegistry();
      if (handleMatchesRegistry(handle, current)) await terminateOwnedHandle(handle);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      exitCode = 1;
    } finally {
      if (reservation) await releaseLifecycleReservation(reservation);
    }
    process.exit(exitCode);
  };
  const onSigint = () => { void cleanup(130); };
  const onSigterm = () => { void cleanup(143); };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return {
    markReservationReleased() {
      reservationReleased = true;
    },
    dispose() {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}
