import { ThemeToggle } from "@/components/theme-toggle";
import { PublicLayout } from "@/components/public-layout";

export default function BlogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PublicLayout breadcrumb="Blog" rightSlot={<ThemeToggle />} footer="rich">
      {children}
    </PublicLayout>
  );
}
