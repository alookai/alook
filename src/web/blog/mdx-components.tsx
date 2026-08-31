import type { MDXComponents } from "mdx/types";

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...components,
    // Blog layout already renders the page H1 from metadata.title.
    // Suppress MDX h1 so posts never ship a duplicate heading.
    h1: () => null,
  };
}
