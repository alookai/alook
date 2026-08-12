export function isBugReportsEnabled(
  env: object,
): boolean {
  return (env as { BUG_REPORTS_ENABLED?: unknown }).BUG_REPORTS_ENABLED === "true";
}

export function projectBugReportsFeature(
  env: object,
): { bugReports: boolean } {
  return { bugReports: isBugReportsEnabled(env) };
}
