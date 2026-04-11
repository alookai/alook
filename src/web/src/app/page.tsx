import { getSession } from "@/lib/session";
import { redirect } from "next/navigation";

export default async function Page() {
  const session = await getSession();
  if (session) redirect("/workspaces");
  redirect("/sign-in");
}
