import type {
  AgentDriverHost,
  PreparedExecutionResource,
  RawOutputEvent,
} from "../contract.js";

export interface FakeAgentDriverHost extends AgentDriverHost {
  readonly rawOutput: RawOutputEvent[];
  readonly releases: Array<Parameters<PreparedExecutionResource["release"]>[0]>;
}

export function createFakeAgentDriverHost(
  overrides: Partial<PreparedExecutionResource> = {},
): FakeAgentDriverHost {
  let id = 0;
  const rawOutput: RawOutputEvent[] = [];
  const releases: Array<Parameters<PreparedExecutionResource["release"]>[0]> = [];
  const resource: PreparedExecutionResource = {
    environmentLayers: {
      base: {},
      hostStatic: {},
      identityProtected: {},
      platformProtected: {},
      runtimeProtected: {},
      networkProtected: {},
      credentialSensitive: {},
    },
    async release(input) { releases.push(input); },
    ...overrides,
  };
  return {
    rawOutput,
    releases,
    async prepareExecution() { return { ok: true, resource }; },
    onRawOutput(event) { rawOutput.push(event); },
    now: () => 1_700_000_000_000 + id,
    createId: () => `fake-${++id}`,
  };
}
