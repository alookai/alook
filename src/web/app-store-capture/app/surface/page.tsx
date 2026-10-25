import { CaptureSurface } from "../../captures/surface"

export default async function SurfacePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams
  return <CaptureSurface scene={typeof query.scene === "string" ? query.scene : "workspace"} beat={Number(query.beat ?? 9)} />
}
