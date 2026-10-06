import { readFileSync, readdirSync } from "node:fs"
import { resolve, relative } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"
import { actionNames, pageRoutes, mutationCoverage, facadeCoverage } from "./coverage"
import { actionVariants } from "./actions"

const web = resolve(import.meta.dirname, "../../..")
const files = (root: string) => readdirSync(root, { recursive: true }).filter((file): file is string => typeof file === "string" && /\.tsx?$/.test(file)).map(file => resolve(root, file))
it("keeps the route whitelist aligned with both builds and parallel route slots", () => {
  const routes = new Set(["src/app", "blog/src/app"].flatMap(root => files(resolve(web, root)).filter(file => file.endsWith("/page.tsx")).map(file => "/" + relative(resolve(web, root), file).split("/").slice(0, -1).filter(segment => !segment.startsWith("(") && !segment.startsWith("@")).join("/"))))
  expect([...routes].sort()).toEqual([...pageRoutes].sort())
})
it("requires every native mutation owner in the inventory and every semantic variant on the whitelist", () => {
  const inventory = new Set<string>([...mutationCoverage, ...facadeCoverage].map(entry => entry.file))
  for (const file of files(resolve(web, "src"))) {
    if (/\.test\./.test(file) || file.includes("/test/")) continue
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ["useMutation", "useCommunityCommandMutation"].includes(node.expression.getText(source))) {
        expect(inventory.has("src/web/" + relative(web, file)), file).toBe(true)
        expect(node.arguments.map(argument => argument.getText(source)).join(" "), file).toContain("observabilityAction")
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  for (const variants of Object.values(actionVariants)) for (const name of Object.values(variants)) expect(actionNames as readonly string[]).toContain(name)
})
