declare module "*.mdx" {
  import type { ComponentType } from "react";
  import type { BlogPost } from "@/lib/blog/types";

  export const metadata: BlogPost;
  export const jsonLd:
    | Record<string, unknown>[]
    | Record<string, unknown>
    | undefined;
  const MDXComponent: ComponentType;
  export default MDXComponent;
}
