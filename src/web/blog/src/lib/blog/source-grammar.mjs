import ts from "typescript";

/**
 * @typedef {{ present: string[], strings: Record<string, string>, tags: unknown, draft: boolean }} StaticBlogMetadata
 */

/** @param {string} content @returns {StaticBlogMetadata | null} */
export function readStaticBlogMetadata(content) {
  const parsed = ts.createSourceFile("post.tsx", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)
      || !(statement.declarationList.flags & ts.NodeFlags.Const)
      || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const declaration = statement.declarationList.declarations.find((item) => ts.isIdentifier(item.name) && item.name.text === "metadata");
    if (!declaration) continue;
    const object = declaration.initializer;
    if (!object || !ts.isObjectLiteralExpression(object)
      || content[object.end - 1] !== "}"
      || parsed.parseDiagnostics.some((error) => error.start >= object.pos && error.start < object.end)) return null;
    const present = [];
    const strings = Object.create(null);
    let tags = null;
    let draft = false;
    for (const property of object.properties) {
      if (!property.name || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) continue;
      const name = property.name.text;
      if (present.includes(name)) continue;
      present.push(name);
      if (!ts.isPropertyAssignment(property)) continue;
      const value = property.initializer;
      if (ts.isStringLiteral(value)) strings[name] = value.text;
      if (name === "draft") draft = value.kind === ts.SyntaxKind.TrueKeyword;
      if (name === "tags" && ts.isArrayLiteralExpression(value)) {
        tags = value.elements.map((element) => ts.isStringLiteral(element) ? element.text : null);
      }
    }
    return { present, strings, tags, draft };
  }
  return null;
}

/** @param {string} content @param {string} [metadataImage] @returns {string[]} */
export function readBlogImageReferences(content, metadataImage) {
  const image = metadataImage === undefined ? readStaticBlogMetadata(content)?.strings.image : metadataImage;
  const sources = image ? [image] : [];
  for (const match of content.matchAll(/<source\b[^>]*\bsrcSet\s*=\s*["']([^"']*)["']/g)) {
    for (const candidate of match[1].split(",")) sources.push(candidate.trim().split(/\s+/)[0]);
  }
  for (const match of content.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)|<img\b[^>]+\bsrc\s*=\s*["']([^"']*)["'][^>]*>/g)) {
    sources.push(match[1] ?? match[2]);
  }
  return sources;
}
