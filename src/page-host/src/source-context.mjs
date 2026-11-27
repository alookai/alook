import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage();
export function sourceMessageId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
export function currentPageSource() { return context.getStore(); }
export function withPageSource(request, action) {
  const source = sourceMessageId(request.headers.get("x-alook-source-message") ?? new URL(request.url).searchParams.get("sourceMessageId"));
  return context.run(source, action);
}
