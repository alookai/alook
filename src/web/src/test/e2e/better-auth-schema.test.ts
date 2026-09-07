import { afterAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { sqlQuery, sqlRun } from "@alook/test-utils"

const TABLE = "deviceCode"
const seed = randomUUID()
const rowId = `better-auth-schema-${seed}`
const deviceCode = `device-${seed}`
const userCode = `user-${seed}`

function insertDeviceCode(id: string, device: string, user: string): void {
  sqlRun(
    `INSERT INTO "deviceCode" (
      "id", "deviceCode", "userCode", "expiresAt", "status"
    ) VALUES (?, ?, ?, ?, 'pending')`,
    id,
    device,
    user,
    new Date(Date.now() + 60_000).toISOString(),
  )
}

afterAll(() => {
  sqlRun(`DELETE FROM "deviceCode" WHERE "id" LIKE ?`, `${rowId}%`)
})

describe("Better Auth 1.7 schema compatibility", () => {
  it("keeps the 1.6 account identity columns without issuer", () => {
    const columns = sqlQuery<{ name: string }>(`PRAGMA table_info("account")`)
      .map((column) => column.name)

    expect(columns).toContain("providerId")
    expect(columns).toContain("accountId")
    expect(columns).not.toContain("issuer")
  })

  it("installs the Device Authorization unique indexes", () => {
    const indexes = sqlQuery<{ name: string; sql: string }>(
      `SELECT name, sql
         FROM sqlite_master
        WHERE type = 'index' AND tbl_name = ?`,
      TABLE,
    )

    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "deviceCode_deviceCode_uidx",
        sql: expect.stringMatching(/CREATE UNIQUE INDEX/i),
      }),
      expect.objectContaining({
        name: "deviceCode_userCode_uidx",
        sql: expect.stringMatching(/CREATE UNIQUE INDEX/i),
      }),
    ]))
  })

  it("rejects duplicate device and user lookup codes", () => {
    insertDeviceCode(rowId, deviceCode, userCode)

    expect(() => {
      insertDeviceCode(`${rowId}-device`, deviceCode, `${userCode}-other`)
    }).toThrow(/UNIQUE constraint failed/i)

    expect(() => {
      insertDeviceCode(`${rowId}-user`, `${deviceCode}-other`, userCode)
    }).toThrow(/UNIQUE constraint failed/i)
  })
})
