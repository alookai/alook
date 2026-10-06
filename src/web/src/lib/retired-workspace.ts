export function isRetiredWorkspacePath(pathname: string): boolean {
  try { pathname = decodeURIComponent(pathname) } catch {}
  return pathname === "/w" || pathname.startsWith("/w/")
    || pathname === "/studio/new" || pathname === "/studio/new/"
}
