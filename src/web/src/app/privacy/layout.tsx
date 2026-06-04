import { ThemeToggle } from "@/components/theme-toggle";
import { PublicLayout } from "@/components/public-layout";

export default function PrivacyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PublicLayout rightSlot={<ThemeToggle />} footer="simple">
      {children}
    </PublicLayout>
  );
}
