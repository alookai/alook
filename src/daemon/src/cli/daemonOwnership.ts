export interface DaemonOwnership {
  pid: number;
  machineId: string;
  startedAt: string;
  ownerToken: string;
}

export type DaemonOwnerContext = DaemonOwnership & { baseDir: string };
type PidOwnership = Pick<DaemonOwnership, "pid"> & Partial<Omit<DaemonOwnership, "pid">>;

export function readDaemonOwnership(value: PidOwnership | null): DaemonOwnership | null {
  if (!value || typeof value.machineId !== "string"
    || typeof value.startedAt !== "string" || typeof value.ownerToken !== "string") return null;
  return { pid: value.pid, machineId: value.machineId, startedAt: value.startedAt, ownerToken: value.ownerToken };
}

export function sameDaemonOwnership(a: PidOwnership | null, b: PidOwnership | null): boolean {
  if (!a || !b) return a === b;
  return a.pid === b.pid && a.machineId === b.machineId
    && a.startedAt === b.startedAt && a.ownerToken === b.ownerToken;
}
