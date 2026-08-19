import type { CredentialBroker } from "../credentials/index.js";
import type { RuntimeConfig } from "../runtimeConfig.js";

export interface CredentialProxyHandoff {
  broker: CredentialBroker;
  proxyUrl: string;
  runnerKey: string;
  capabilities: string[];
}

export interface RuntimeContext {
  agentId: string;
  serverId: string;
  computerId: string;
  computerName: string;
  hostname: string;
  os: string;
  daemonVersion: string;
  workspacePath: string;
}

export interface HostLaunchConfig {
  sessionId?: string;
  authToken?: string;
  serverUrl?: string;
  runtimeConfig?: RuntimeConfig;
  description?: string;
  runtimeContext?: RuntimeContext;
  agentName?: string;
  agentDiscriminator?: string;
  agentHandle?: string;
  ownerHandle?: string;
}

export interface HostLaunchContext {
  agentId: string;
  launchId?: string;
  workingDirectory: string;
  standingPrompt: string;
  prompt: string;
  agentCliPath?: string;
  daemonApiKey?: string;
  cliTransportTraceDir?: string;
  credentialProxy?: CredentialProxyHandoff;
  config: HostLaunchConfig;
}
