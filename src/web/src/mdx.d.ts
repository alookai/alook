declare module "*.mdx" {
  import type { ComponentType } from "react";
  import type { BlogPost } from "@/lib/blog/types";

  export const metadata: BlogPost;
  const MDXComponent: ComponentType;
  export default MDXComponent;
}
