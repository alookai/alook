import path from "node:path"
import type { NextConfig } from "next"

const config: NextConfig = {
  agentRules: false,
  turbopack: { root: path.resolve(__dirname, "../../..") },
}

export default config
