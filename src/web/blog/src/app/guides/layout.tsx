import { PublicLayout } from "@/components/public-layout";
import { ThemeToggle } from "@/components/theme-toggle";
import { BlogFooter } from "../blog/blog-footer";

export default function GuidesLayout({ children }: { children: React.ReactNode }) {
  return <PublicLayout zone="blog" breadcrumb="Guides" rightSlot={<ThemeToggle />} footer={<BlogFooter />}>{children}</PublicLayout>;
}
