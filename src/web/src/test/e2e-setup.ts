import { afterAll } from "vitest"
import { closeDb } from "@alook/test-utils"

if (!process.env.APP_URL) {
  process.env.APP_URL = "http://localhost:3000"
}

afterAll(() => {
  closeDb()
})
