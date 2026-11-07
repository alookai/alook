import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import catalog from "../catalog/catalog.json"

const labels: Record<string, string> = {
  direct: "Direct example",
  composition: "Inside a composition",
  nonvisual: "No separate visual output",
  environment: "Application environment",
  "server-output": "Server-generated output",
  pending: "Needs an example",
  blocked: "Blocked",
}

const storyLabels = new Map(catalog.stories.map((story) => [story.id, `${story.title} / ${story.name}`]))

function SourceCatalog() {
  const [query, setQuery] = useState("")
  const [application, setApplication] = useState("all")
  const [kind, setKind] = useState("all")
  const [limit, setLimit] = useState(40)
  const search = query.trim().toLowerCase()
  const entries = catalog.entries.filter((entry) => (application === "all" || entry.application === application) && (kind === "all" || entry.kind === kind) && (!search || `${entry.source} ${entry.candidates.join(" ")} ${entry.reason} ${entry.examples.map((example) => example.region).join(" ")}`.toLowerCase().includes(search)))
  return (
    <main className="space-y-5 p-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Source catalog</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">Find the example for a Web or Blog source file. A composition link identifies the region that uses the original component.</p>
        <p className="max-w-3xl text-sm">{catalog.entries.length} source files · {catalog.stories.length} registered examples. These are author declarations. They do not show which examples have passed rendering or interaction checks.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-48 flex-1 text-sm">Search source or component<Input className="mt-1" value={query} placeholder="For example: ProfileCard" onChange={(event) => { setQuery(event.target.value); setLimit(40) }} /></label>
        <label className="text-sm">Application<select className="mt-1 block h-8 rounded-lg border border-input bg-background px-2" value={application} onChange={(event) => { setApplication(event.target.value); setLimit(40) }}><option value="all">Web and Blog</option><option value="Web">Web</option><option value="Blog">Blog</option></select></label>
        <label className="text-sm">Exposure<select className="mt-1 block h-8 rounded-lg border border-input bg-background px-2" value={kind} onChange={(event) => { setKind(event.target.value); setLimit(40) }}><option value="all">All exposures</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <p role="status" className="text-sm text-muted-foreground">{entries.length} matching source files. Showing {Math.min(limit, entries.length)}.</p>
      <ul className="divide-y divide-border">
        {entries.slice(0, limit).map((entry) => (
          <li key={entry.source} className="space-y-2 py-4">
            <div className="flex flex-wrap items-center gap-2"><span className="rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground">{entry.application} · {labels[entry.kind] ?? entry.kind}</span><code className="min-w-0 break-all text-sm">{entry.source}</code></div>
            {entry.candidates.length > 0 && <p className="wrap-break-word text-xs text-muted-foreground">{entry.candidates.join(", ")}</p>}
            <p className="max-w-4xl text-sm">{entry.reason}</p>
            {entry.examples.length > 0 && <ul className="space-y-2">{entry.examples.map((example) => <li key={`${example.story}:${example.region}`} className="text-sm"><a className="text-primary underline underline-offset-4" href={`/?path=/story/${example.story}`} target="_top">{storyLabels.get(example.story) ?? example.story}</a><p className="mt-1 text-muted-foreground">{example.region}</p></li>)}</ul>}
          </li>
        ))}
      </ul>
      {entries.length > limit && <Button variant="outline" onClick={() => setLimit((value) => value + 40)}>Show 40 more</Button>}
      {entries.length === 0 && <p className="text-sm">No source files match these filters.</p>}
    </main>
  )
}

const meta = { title: "Catalog/Source catalog", component: SourceCatalog, tags: ["ai-generated"], parameters: { layout: "fullscreen" } } satisfies Meta<typeof SourceCatalog>
export default meta
type Story = StoryObj<typeof meta>
export const Browse: Story = {}
