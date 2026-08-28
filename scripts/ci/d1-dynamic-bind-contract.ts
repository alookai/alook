import { readFileSync, readdirSync } from "node:fs"
import { relative, resolve } from "node:path"
import ts from "typescript"

export type DynamicBindOperator = "inArray" | "notInArray" | "values" | "or-map" | "sql.join"

export interface DynamicBindSite {
  key: string
  file: string
  functionName: string
  operator: DynamicBindOperator
  strategyHint: "fixed-literal" | "exact-chunk" | "json-set" | "subquery"
  fixedParamsHint?: number
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : []
  })
}

function propertyName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return undefined
}

function isArrayType(type: ts.TypeNode | undefined): boolean {
  if (!type) return false
  if (ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type)) return true
  return ts.isTypeReferenceNode(type)
    && ts.isIdentifier(type.typeName)
    && (type.typeName.text === "Array" || type.typeName.text === "ReadonlyArray")
}

function isDynamicValuesArgument(node: ts.Node): boolean {
  if (ts.isObjectLiteralExpression(node)) return false
  if (ts.isArrayLiteralExpression(node)) return node.elements.some(ts.isSpreadElement)
  if (!ts.isIdentifier(node)) return true
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      const parameter = current.parameters.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === node.text,
      )
      if (parameter) return isArrayType(parameter.type)
      break
    }
  }
  return true
}

function enclosingFunctionName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (ts.isMethodDeclaration(current) && current.name) return propertyName(current.name) ?? "<method>"
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent) {
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text
      if (ts.isPropertyAssignment(current.parent)) return propertyName(current.parent.name) ?? "<property>"
    }
  }
  return "<module>"
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current
  }
  return undefined
}

function bindStrategyHint(node: ts.CallExpression, operator: DynamicBindOperator) {
  if (operator !== "inArray" && operator !== "notInArray") {
    return { strategyHint: "exact-chunk" as const, fixedParamsHint: 10 }
  }
  const argument = node.arguments[1]
  if (argument && ts.isArrayLiteralExpression(argument) && !argument.elements.some(ts.isSpreadElement)) {
    return { strategyHint: "fixed-literal" as const }
  }
  const sourceFile = node.getSourceFile()
  const argumentText = argument?.getText(sourceFile).replace(/!$/, "") ?? ""
  const functionText = enclosingFunction(node)?.getText(sourceFile) ?? ""
  if (argumentText.includes("jsonTextSet(")
    || new RegExp(`(?:const|let)\\s+${argumentText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=[\\s\\S]{0,80}?jsonTextSet\\(`).test(functionText)) {
    return { strategyHint: "json-set" as const }
  }
  if (argumentText.includes(".select(")
    || new RegExp(`(?:const|let)\\s+${argumentText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*db[\\s\\S]{0,80}?\\.select\\(`).test(functionText)) {
    return { strategyHint: "subquery" as const }
  }
  return { strategyHint: "exact-chunk" as const, fixedParamsHint: 10 }
}

function callOperator(node: ts.CallExpression): DynamicBindOperator | undefined {
  if (ts.isIdentifier(node.expression) && (node.expression.text === "inArray" || node.expression.text === "notInArray")) {
    return node.expression.text
  }
  if (ts.isPropertyAccessExpression(node.expression)) {
    if (node.expression.name.text === "join" && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "sql") {
      return "sql.join"
    }
    if (node.expression.name.text === "values" && node.arguments[0] && isDynamicValuesArgument(node.arguments[0])) {
      return "values"
    }
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "or"
    && node.arguments.some((argument) => ts.isSpreadElement(argument))) {
    return "or-map"
  }
  return undefined
}

export function scanDynamicBindSites(root: string, sourceOverride?: { file: string; source: string }): DynamicBindSite[] {
  const queryRoot = resolve(root, "src/shared/src/db/queries")
  const files = sourceOverride ? [sourceOverride.file] : sourceFiles(queryRoot)
  const sites: DynamicBindSite[] = []
  const ordinals = new Map<string, number>()

  for (const file of files) {
    const source = sourceOverride?.source ?? readFileSync(file, "utf8")
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const operator = callOperator(node)
        if (operator) {
          const functionName = enclosingFunctionName(node)
          const scope = `${file}:${functionName}:${operator}`
          const ordinal = (ordinals.get(scope) ?? 0) + 1
          ordinals.set(scope, ordinal)
          const relativeFile = sourceOverride ? sourceOverride.file : relative(root, file).replaceAll("\\", "/")
          const key = `${relativeFile}:${functionName}:${operator}:${ordinal}`
          const hint = bindStrategyHint(node, operator)
          const fixedParamsByKey: Record<string, number> = {
            "src/shared/src/db/queries/community/channel.ts:resolveVisibleChannelIdSet:inArray:1": 0,
            "src/shared/src/db/queries/community/channel.ts:resolveVisibleChannelIdSet:inArray:2": 2,
            "src/shared/src/db/queries/community/member.ts:getMembersByUserIds:inArray:1": 1,
            "src/shared/src/db/queries/community/reaction.ts:listReactionsByMessageIds:inArray:1": 0,
          }
          sites.push({
            key,
            file: relativeFile,
            functionName,
            operator,
            ...hint,
            ...(hint.strategyHint === "exact-chunk" && key in fixedParamsByKey
              ? { fixedParamsHint: fixedParamsByKey[key] }
              : {}),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
  }

  return sites.sort((left, right) => left.key.localeCompare(right.key))
}
