import { afterAll } from "vitest"
import { closeDb } from "@alook/test-utils"
import { DEV_PORTS } from "@alook/shared"

if (!process.env.APP_URL) {
  process.env.APP_URL = `http://localhost:${DEV_PORTS.web}`
}

afterAll(() => {
  closeDb()
})
