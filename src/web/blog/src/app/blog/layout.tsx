import { ThemeToggle } from "@/components/theme-toggle";
import { PublicLayout } from "@/components/public-layout";
import { GithubOutboundBoundary } from "@/components/github-outbound-link";

export default function BlogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PublicLayout zone="blog" breadcrumb="Blog" rightSlot={<ThemeToggle />} footer="rich">
      <GithubOutboundBoundary surface="blog">
        {children}
      </GithubOutboundBoundary>
    </PublicLayout>
  );
}
