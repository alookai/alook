export type SsrGeometry = Record<string, { x: number; y: number; width: number; height: number }>

export type SsrLifecycleSample = {
  timestamp: number
  phase: "parsing" | "ssr" | "hydrating"
  readyState: DocumentReadyState
  shellChildCount: number
  incompleteShellHtml?: string
  overflow: number
  geometry: SsrGeometry
}

export function ssrGeometryErrors(
  samples: SsrLifecycleSample[],
  width: number,
  surface: "list" | "detail",
): string[] {
  const errors: string[] = []
  const widths: Record<string, number> = surface === "list"
    ? { rail: 56, shell: width, sidebar: width - 57, surface: width - 56, userBar: width }
    : { main: width, shell: width, surface: width }
  const expected = Object.keys(widths).sort().join(",")
  let baseline: SsrGeometry | undefined
  if (samples.length === 0) errors.push("no lifecycle samples")
  for (const [index, sample] of samples.entries()) {
    const label = `sample ${index} (${sample.phase})`
    if (sample.overflow !== 0) errors.push(`${label}: horizontal overflow ${sample.overflow}`)
    for (const [name, rect] of Object.entries(sample.geometry)) {
      if (!(name in widths)) errors.push(`${label}: unexpected module ${name}`)
      else if (Math.abs(rect.width - widths[name]) >= 0.5) {
        errors.push(`${label}: ${name} width ${rect.width}, expected ${widths[name]}`)
      }
    }
    if (sample.phase === "parsing") continue
    if (Object.keys(sample.geometry).sort().join(",") !== expected) {
      errors.push(`${label}: incomplete modules ${Object.keys(sample.geometry).join(",")}`)
      continue
    }
    baseline ??= sample.geometry
    for (const [name, rect] of Object.entries(sample.geometry)) {
      for (const coordinate of ["x", "y", "width", "height"] as const) {
        if (Math.abs(baseline[name][coordinate] - rect[coordinate]) > 1) {
          errors.push(`${label}: ${name}.${coordinate} drift`)
        }
      }
    }
  }
  if (!baseline) errors.push("no complete parsed-document sample")
  return errors
}
