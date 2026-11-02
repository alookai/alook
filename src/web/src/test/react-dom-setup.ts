import { expect } from "vitest"
import * as matchers from "@testing-library/jest-dom/matchers"
import type {} from "@testing-library/jest-dom/vitest"

// Use the current runner's expect. The external Vitest adapter can load a
// second pnpm peer instance when these projects run from the repository root.
expect.extend(matchers)
