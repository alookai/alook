import { BlogFooter } from "./blog-footer";
import { PublicLayout } from "@/components/public-layout";
import { GithubOutboundBoundary } from "@/components/github-outbound-link";
import { BlogNavCenter, BlogNavRight } from "@blog/components/blog/blog-nav-actions";

export default function BlogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PublicLayout
      zone="blog"
      breadcrumb="Blog"
      centerSlot={<BlogNavCenter />}
      rightSlot={<BlogNavRight />}
      footer={<BlogFooter />}
    >
      <GithubOutboundBoundary surface="blog">
        {children}
      </GithubOutboundBoundary>
    </PublicLayout>
  );
}
