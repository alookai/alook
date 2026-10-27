import { PublicLayout } from "@/components/public-layout";
import { ThemeToggle } from "@/components/theme-toggle";
import { BlogFooter } from "../blog/blog-footer";

export default function TutorialsLayout({ children }: { children: React.ReactNode }) {
  return <PublicLayout zone="blog" breadcrumb="Tutorials" rightSlot={<ThemeToggle />} footer={<BlogFooter />}>{children}</PublicLayout>;
}
