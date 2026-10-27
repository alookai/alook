import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { PageError, type PageLimits, type Operation } from "./contracts"
import { pages, type PageRow } from "./schema"

export class Registry {
  private readonly db
  constructor(binding: D1Database, readonly namespace: string, readonly account: string) {
    this.db = drizzle(binding)
  }

  async get(id: string): Promise<PageRow> {
    const [row] = await this.db.select().from(pages).where(and(eq(pages.id, id), eq(pages.namespace, this.namespace), eq(pages.account, this.account)))
    if (!row) throw new PageError("page_not_found", 404)
    return row
  }

  async byPrefix(prefix: string): Promise<PageRow | undefined> {
    const [row] = await this.db.select().from(pages).where(and(eq(pages.prefix, prefix), eq(pages.namespace, this.namespace), eq(pages.account, this.account)))
    return row
  }

  async create(prefix: string, digest: string, limits: PageLimits): Promise<PageRow> {
    const id = crypto.randomUUID()
    const operation = this.operation(id, 1, digest, "publish")
    const now = operation.startedAt
    try {
      const [row] = await this.db.insert(pages).values({
        id, prefix, namespace: this.namespace, account: this.account, phase: "publishing", active: null,
        releases: [operation], operation, currentOp: operation.operationId, stage: "reserved",
        error: null, revision: 1, version: 1, limits, createdAt: now, updatedAt: now,
      }).returning()
      return row
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: pages.prefix/.test(`${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`)) {
        throw new PageError("prefix_occupied", 409)
      }
      throw error
    }
  }

  async patch(row: PageRow, change: Partial<Omit<PageRow, "id" | "prefix" | "namespace" | "account" | "version" | "createdAt">>): Promise<PageRow | undefined> {
    const [updated] = await this.db.update(pages).set({ ...change, version: row.version + 1, updatedAt: new Date().toISOString() })
      .where(and(eq(pages.id, row.id), eq(pages.namespace, this.namespace), eq(pages.account, this.account), eq(pages.version, row.version))).returning()
    return updated
  }

  async claim(id: string, kind: Operation["kind"], digest = ""): Promise<PageRow> {
    const row = await this.get(id)
    if (row.currentOp) throw new PageError("operation_in_progress", 409)
    if (row.phase === "deleting") throw new PageError("page_deleting", 409)
    if (kind === "publish" && row.releases.length >= 64) throw new PageError("cleanup_required", 409)
    const revision = row.revision + 1
    const operation = this.operation(id, revision, digest, kind)
    const updated = await this.patch(row, {
      revision, operation, currentOp: operation.operationId, error: null,
      phase: kind === "delete" ? "deleting" : row.active ? "ready" : "publishing",
      stage: kind === "publish" ? "reserved" : kind === "delete" ? "deleting" : "cleanup",
      releases: kind === "publish" ? [...row.releases, operation] : row.releases,
    })
    if (!updated) throw new PageError("operation_in_progress", 409)
    return updated
  }

  async forOperation(id: string, opId: string, change: (row: PageRow) => Parameters<Registry["patch"]>[1] | undefined): Promise<PageRow> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await this.get(id)
      if (row.currentOp !== opId) return row
      const values = change(row)
      if (!values) return row
      const updated = await this.patch(row, values)
      if (updated) return updated
    }
    throw new PageError("operation_in_progress", 409)
  }

  async remove(row: PageRow): Promise<boolean> {
    const deleted = await this.db.delete(pages).where(and(eq(pages.id, row.id), eq(pages.namespace, this.namespace), eq(pages.account, this.account), eq(pages.version, row.version))).returning({ id: pages.id })
    return deleted.length === 1
  }

  private operation(id: string, revision: number, digest: string, kind: Operation["kind"]): Operation {
    return { target: `p-${id.replaceAll("-", "")}-${revision}`, operationId: crypto.randomUUID(), digest, kind, startedAt: new Date().toISOString() }
  }
}
