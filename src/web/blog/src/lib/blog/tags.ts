export function validBlogTags(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(
    (tag) => typeof tag === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag),
  ) && new Set(value).size === value.length);
}
