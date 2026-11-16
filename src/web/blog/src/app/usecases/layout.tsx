import { PublicLayout } from "@/components/public-layout";
import { ThemeToggle } from "@/components/theme-toggle";
import { BlogFooter } from "../blog/blog-footer";

export default function UseCasesLayout({ children }: { children: React.ReactNode }) {
  return <PublicLayout zone="blog" navClassName="max-w-270 px-4 sm:px-6" breadcrumb="Use cases" breadcrumbHref="/usecases" rightSlot={<ThemeToggle />} footer={<BlogFooter />}>{children}</PublicLayout>;
}
