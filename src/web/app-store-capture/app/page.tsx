import { Artwork } from "../captures/poster"

export default async function CapturePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams
  const story = Number(query.story ?? 1)
  return <Artwork kind={typeof query.kind === "string" ? query.kind : "phone"} story={story >= 1 && story <= 6 ? story : 1} large={query.large === "1"} />
}
