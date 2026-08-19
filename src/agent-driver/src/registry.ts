import {
  AgentDriverContractError,
  assertAgentRuntimeId,
  isAgentRuntimeId,
  validateAgentDriverDescriptor,
  type AgentDriver,
  type AgentDriverDescriptor,
  type AgentDriverLaunch,
  type AgentRuntimeId,
} from "./contracts.js";
import type { AgentDriverHost } from "./host.js";

export interface AgentDriverRegistry<THost extends AgentDriverHost = AgentDriverHost> {
  register(driver: AgentDriver<THost>): void;
  has(runtimeId: string): runtimeId is AgentRuntimeId;
  get(runtimeId: string): AgentDriver<THost>;
  listRuntimeIds(): readonly AgentRuntimeId[];
  listDescriptors(): readonly AgentDriverDescriptor[];
}

function snapshotDriver<THost extends AgentDriverHost>(driver: AgentDriver<THost>): AgentDriver<THost> {
  validateAgentDriverDescriptor(driver.descriptor);
  const descriptor = Object.freeze({
    ...driver.descriptor,
    lifecycle: Object.freeze({ ...driver.descriptor.lifecycle }),
    transport: Object.freeze({ ...driver.descriptor.transport }),
    terminal: Object.freeze({ ...driver.descriptor.terminal }),
    resume: Object.freeze({ ...driver.descriptor.resume }),
    model: Object.freeze({ ...driver.descriptor.model }),
    capabilities: Object.freeze({ ...driver.descriptor.capabilities }),
  });
  return Object.freeze({
    descriptor,
    probe: (host: THost) => driver.probe(host),
    open: (launch: AgentDriverLaunch<THost>) => driver.open(launch),
  });
}

class DefaultAgentDriverRegistry<THost extends AgentDriverHost> implements AgentDriverRegistry<THost> {
  private readonly drivers = new Map<AgentRuntimeId, AgentDriver<THost>>();

  constructor(drivers: readonly AgentDriver<THost>[]) {
    for (const driver of drivers) this.register(driver);
  }

  register(driver: AgentDriver<THost>): void {
    const runtimeId = driver.descriptor.id;
    if (this.drivers.has(runtimeId)) {
      throw new AgentDriverContractError("duplicate_runtime", `Agent runtime already registered: ${runtimeId}`);
    }
    this.drivers.set(runtimeId, snapshotDriver(driver));
  }

  has(runtimeId: string): runtimeId is AgentRuntimeId {
    return isAgentRuntimeId(runtimeId) && this.drivers.has(runtimeId);
  }

  get(runtimeId: string): AgentDriver<THost> {
    const id = assertAgentRuntimeId(runtimeId);
    const driver = this.drivers.get(id);
    if (!driver) {
      throw new AgentDriverContractError("runtime_not_registered", `Agent runtime is not registered: ${id}`);
    }
    return driver;
  }

  listRuntimeIds(): readonly AgentRuntimeId[] {
    return Object.freeze([...this.drivers.keys()]);
  }

  listDescriptors(): readonly AgentDriverDescriptor[] {
    return Object.freeze([...this.drivers.values()].map((driver) => driver.descriptor));
  }
}

export function createAgentDriverRegistry<THost extends AgentDriverHost = AgentDriverHost>(
  drivers: readonly AgentDriver<THost>[] = [],
): AgentDriverRegistry<THost> {
  return new DefaultAgentDriverRegistry(drivers);
}
