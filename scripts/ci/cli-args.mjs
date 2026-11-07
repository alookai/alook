export function parseArgs(argv) {
  const [command, ...rest] = argv
  const args = { command }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (!key?.startsWith("--") || value == null) throw new Error(`Invalid argument: ${key ?? "<missing>"}`)
    args[key.slice(2)] = value
  }
  return args
}
