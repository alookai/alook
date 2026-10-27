import { unified } from "unified"
import type { Plugin } from "unified"
import type { Root } from "hast"
import { mermaid, cjk, math } from "@/lib/streamdown-plugins"
import { withRedactedDiagrams } from "./redacted-diagram"
import { redactedContentPlugin } from "./redacted-content"

const mathRenderer = unified().use([math.rehypePlugin]).use(redactedContentPlugin)
const renderMath: Plugin<[], Root> = () => (tree) => mathRenderer.runSync(tree) as Root
const fullMessagePlugins = { mermaid: withRedactedDiagrams(mermaid), cjk, math: { ...math, rehypePlugin: renderMath } }
export default fullMessagePlugins
