import { afterAll } from "vitest"
import { closeDb } from "@alook/test-utils"
import { DEV_WEB_URL } from "@alook/shared"

if (!process.env.APP_URL) {
  process.env.APP_URL = DEV_WEB_URL
}

afterAll(() => {
  closeDb()
})
