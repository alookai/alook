const raw = process.env.CI_GATE_RESULTS

if (!raw) {
  throw new Error("CI_GATE_RESULTS is required")
}

const checks = JSON.parse(raw)
const errors = []

for (const check of checks) {
  const expected = check.expected === true || check.expected === "true"
  const accepted = expected ? check.result === "success" : check.result === "skipped"
  if (!accepted) {
    errors.push(
      `${check.name}: expected ${expected ? "success" : "skipped"}, received ${check.result}`
    )
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`)
  process.exit(1)
}

process.stdout.write("All expected CI jobs completed successfully.\n")
