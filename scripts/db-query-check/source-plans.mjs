import { resolve } from 'node:path'
import ts from 'typescript'

function literal(node, checker, ancestors = new Set()) {
  if (!node || ancestors.has(node)) return undefined
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text)
  if (!ts.isIdentifier(node)) return undefined
  let symbol = checker.getSymbolAtLocation(node)
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
  const declaration = symbol?.valueDeclaration
  if (!declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined
  ancestors.add(node)
  return literal(declaration.initializer, checker, ancestors)
}

export function fixedD1Read(node, checker) {
  const sql = literal(node.arguments[0], checker)
  if (typeof sql !== 'string' || !/^\s*select\b/i.test(sql)) return undefined
  const member = node.parent
  const bind = member && ts.isPropertyAccessExpression(member) && member.name.text === 'bind' && member.parent
  if (bind && ts.isCallExpression(bind) && bind.expression === member) {
    const params = bind.arguments.map(arg => literal(arg, checker))
    if (params.some(value => value === undefined)) return undefined
    return { sql, params }
  }
  if (!/[?:@$]/.test(sql)) return { sql, params: [] }
}

const pureOperators = new Set(['and', 'or', 'eq', 'ne', 'isNull', 'isNotNull', 'asc', 'desc'])
const readMethods = new Set(['select', 'selectDistinct', 'from', 'where', 'orderBy', 'limit'])

function parameterValues(parameter) {
  if (parameter.initializer || parameter.questionToken || parameter.dotDotDotToken) return undefined
  if (parameter.type?.kind === ts.SyntaxKind.StringKeyword) return ['sql-check-sample']
  if (!parameter.type || !ts.isUnionTypeNode(parameter.type)) return undefined
  const values = parameter.type.types.map(variant => {
    if (!ts.isTypeLiteralNode(variant) || variant.members.length !== 1) return undefined
    const member = variant.members[0]
    if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name) || member.questionToken ||
        member.type?.kind !== ts.SyntaxKind.StringKeyword) return undefined
    return Object.assign(Object.create(null), { [member.name.text]: 'sql-check-sample' })
  })
  return values.includes(undefined) ? undefined : values
}

export function sourceDrizzleRead(node, builder, checker, root) {
  const parent = builder.parent
  const terminal = ts.isPropertyAccessExpression(parent) && ['all', 'get', 'execute'].includes(parent.name.text) &&
    ts.isCallExpression(parent.parent) && parent.parent.expression === parent
  if (!ts.isAwaitExpression(parent) && !terminal) return undefined
  const receiver = node.expression.expression
  if (!ts.isIdentifier(receiver)) return undefined
  const dbParameter = checker.getSymbolAtLocation(receiver)?.valueDeclaration
  if (!dbParameter || !ts.isParameter(dbParameter) || !dbParameter.type || !ts.isTypeReferenceNode(dbParameter.type)) return undefined
  let dbType = checker.getSymbolAtLocation(dbParameter.type.typeName)
  if (dbType && dbType.flags & ts.SymbolFlags.Alias) dbType = checker.getAliasedSymbol(dbType)
  if (!dbType?.declarations?.some(declaration => declaration.getSourceFile().fileName === resolve(root, 'src/shared/src/db/index.ts'))) return undefined
  const inputs = new Map([[receiver.text, { db: true }]])
  const symbols = new Map([[receiver.text, checker.getSymbolAtLocation(receiver)]])
  const visiting = new Set()
  const calls = methods(builder)
  if (!query(builder) || new Set(calls).size !== calls.length || !calls.includes('from') ||
      [...inputs.values()].filter(input => input.table).length !== 1) return undefined
  let variants = [[]]
  for (const spec of inputs.values()) {
    const values = spec.values ?? [null]
    if (variants.length * values.length > 8) return undefined
    variants = variants.flatMap(variant => values.map(value => [...variant, value]))
  }
  return { expression: builder.getText(), inputs: [...inputs], variants }

  function methods(expr) {
    return ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)
      ? [...methods(expr.expression.expression), expr.expression.name.text]
      : []
  }

  function query(expr) {
    if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression) ||
        !readMethods.has(expr.expression.name.text) || expr.typeArguments?.length ||
        !expr.arguments.every(value)) return false
    const base = expr.expression.expression
    const name = expr.expression.name.text
    if (name === 'from' && (expr.arguments.length !== 1 || !ts.isIdentifier(expr.arguments[0]) || !inputs.get(expr.arguments[0].text)?.table)) return false
    if (name === 'limit' && !expr.arguments.every(ts.isNumericLiteral)) return false
    if (expr === node) return true
    return query(base)
  }

  function value(expr) {
    if (ts.isStringLiteralLike(expr) || ts.isNumericLiteral(expr) ||
        [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(expr.kind)) return true
    if (ts.isIdentifier(expr)) return identifier(expr)
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
      return identifier(expr.expression) && !['__proto__', 'constructor', 'prototype'].includes(expr.name.text) &&
        (inputs.get(expr.expression.text)?.values?.some(sample => sample != null && Object.hasOwn(sample, expr.name.text)) ||
          (inputs.get(expr.expression.text)?.table && checker.getSymbolAtLocation(expr.name) !== undefined))
    }
    if (ts.isObjectLiteralExpression(expr)) return expr.properties.every(prop =>
      ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text !== '__proto__' && value(prop.initializer))
    if (ts.isConditionalExpression(expr) && ts.isBinaryExpression(expr.condition)) {
      const { left, operatorToken, right } = expr.condition
      return operatorToken.kind === ts.SyntaxKind.InKeyword && ts.isStringLiteralLike(left) &&
        ts.isIdentifier(right) && identifier(right) &&
        inputs.get(right.text)?.values?.some(sample => sample != null && Object.hasOwn(sample, left.text)) &&
        value(expr.whenTrue) && value(expr.whenFalse)
    }
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && !expr.typeArguments?.length) {
      return identifier(expr.expression) && inputs.get(expr.expression.text)?.operator && expr.arguments.every(value)
    }
    return false
  }

  function identifier(expr) {
    const name = expr.text
    const symbol = checker.getSymbolAtLocation(expr)
    if (inputs.has(name)) return symbols.get(name) === symbol && !inputs.get(name).db
    if (!symbol || visiting.has(symbol)) return false
    symbols.set(name, symbol)
    const declaration = symbol.declarations?.[0]
    if (declaration && ts.isParameter(declaration)) {
      const samples = parameterValues(declaration)
      if (!samples) return false
      inputs.set(name, { values: samples })
      return true
    }
    if (declaration && ts.isImportSpecifier(declaration)) {
      const origin = declaration.parent.parent.parent.moduleSpecifier.text
      const imported = declaration.propertyName?.text ?? name
      if (origin === 'drizzle-orm' && pureOperators.has(imported)) {
        inputs.set(name, { operator: imported })
        return true
      }
      const table = checker.getAliasedSymbol(symbol).valueDeclaration
      const path = table?.getSourceFile().fileName.replaceAll('\\', '/')
      if (path?.startsWith(resolve(root, 'src/shared/src/db').replaceAll('\\', '/') + '/') &&
          /\/(?:[^/]+-)?schema\.ts$/.test(path) && ts.isVariableDeclaration(table) &&
          table.initializer && ts.isCallExpression(table.initializer) &&
          ts.isIdentifier(table.initializer.expression) && table.initializer.expression.text === 'sqliteTable') {
        inputs.set(name, { table: imported })
        return true
      }
    }
    const original = declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
    const initializer = original && ts.isAsExpression(original) && original.type.getText() === 'const' ? original.expression : original
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const &&
        initializer && ts.isObjectLiteralExpression(initializer)) {
      visiting.add(symbol)
      const safe = value(initializer)
      visiting.delete(symbol)
      if (!safe) return false
      inputs.set(name, { initializer: initializer.getText() })
      return true
    }
    return false
  }
}
