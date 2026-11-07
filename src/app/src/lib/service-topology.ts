import type { DevPortProfile } from "@alook/shared";
import type { Command } from "commander";

export const SELF_HOSTED_SERVICES = [
  { key: "web", directory: "web", label: "Web", option: "--port-web <port>", argument: "portWeb", description: "Web server port", defaultPort: 15210, inspectorPort: 19229 },
  { key: "emailWorker", directory: "email-worker", label: "Email Worker", option: "--port-email <port>", argument: "portEmail", description: "Email worker port", defaultPort: 15211, inspectorPort: 19231, urlVariable: "DEV_EMAIL_WORKER_URL" },
  { key: "wsDo", directory: "ws-do", label: "WS-DO", option: "--port-ws <port>", argument: "portWs", description: "WebSocket worker port", defaultPort: 15212, inspectorPort: 19230, urlVariable: "DEV_WS_DO_URL" },
  { key: "queueWorker", directory: "queue-worker", label: "Queue Worker", option: "--port-wake <port>", argument: "portWake", description: "Wake worker port", defaultPort: 15213, inspectorPort: 19232, urlVariable: "DEV_QUEUE_WORKER_URL" },
] as const;

export type ServiceKey = (typeof SELF_HOSTED_SERVICES)[number]["key"];

export const DEFAULT_SELF_HOSTED_PORTS: DevPortProfile = Object.fromEntries(
  SELF_HOSTED_SERVICES.map((service) => [service.key, service.defaultPort]),
) as Record<ServiceKey, number>;

export function addServicePortOptions(command: Command, defaults: DevPortProfile): Command {
  for (const service of SELF_HOSTED_SERVICES) {
    command.option(service.option, service.description, String(defaults[service.key]));
  }
  return command;
}

export function servicePortsFromOptions(options: Record<string, string>): DevPortProfile {
  return Object.fromEntries(SELF_HOSTED_SERVICES.map((service) => [
    service.key, parseInt(options[service.argument], 10),
  ])) as Record<ServiceKey, number>;
}
