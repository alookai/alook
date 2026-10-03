import { replaceEqualDeep, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query"

const publication = Symbol("native-query-publication")
export type QueryReceipt = { client: QueryClient; queryKey: QueryKey; resource: Query | undefined; writes: number }

export function captureQueryReceipt(client: QueryClient, queryKey: QueryKey): QueryReceipt {
  const resource = client.getQueryCache().find({ queryKey, exact: true })
  return { client, queryKey, resource, writes: resource?.state.dataUpdateCount ?? 0 }
}
export function isQueryReceiptCurrent(receipt: QueryReceipt) {
  const current = receipt.client.getQueryCache().find({ queryKey: receipt.queryKey, exact: true })
  return current === receipt.resource && (current?.state.dataUpdateCount ?? 0) === receipt.writes
}
export function withQueryReceipt<T extends object>(value: T, receipt: QueryReceipt, merge?: (previous: unknown, incoming: unknown) => unknown): T {
  const data = Array.isArray(value) ? [...value] : { ...value }
  Object.defineProperty(data, publication, { value: { receipt, merge } })
  return data as T
}
export function reconcileQueryReceipt(previous: unknown, incoming: unknown) {
  if (!incoming || typeof incoming !== "object") return replaceEqualDeep(previous, incoming)
  const proof = (incoming as { [publication]?: { receipt: QueryReceipt; merge?: (previous: unknown, incoming: unknown) => unknown } })[publication]
  if (!proof) return replaceEqualDeep(previous, incoming)
  const value = Array.isArray(incoming) ? [...incoming] : { ...incoming }
  if (isQueryReceiptCurrent(proof.receipt)) return replaceEqualDeep(previous, value)
  const resource = proof.receipt.client.getQueryCache().find({ queryKey: proof.receipt.queryKey, exact: true })
  if (resource !== proof.receipt.resource || !proof.merge) return previous
  return replaceEqualDeep(previous, proof.merge(previous, value))
}
