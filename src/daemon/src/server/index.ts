/**
 * Server layer — the agent ⇄ server API contract + a local in-memory mock.
 *
 *   contract.ts          — the ServerApi interface + domain types (server-scoped).
 *   mockServer.ts        — in-memory ServerApi for local execution / tests.
 *   wsControlChannel     — WebSocket HostControlChannel (reconnect + heartbeat).
 *   wsControlServer      — WebSocket server for the control plane.
 */
export * from "./contract.js";
export * from "./mockServer.js";
export * from "./wsControlChannel.js";
export * from "./wsControlServer.js";
