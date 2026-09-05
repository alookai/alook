import {
  nativeOauthAttemptIdSchema,
  nativeOauthFailureCodeSchema,
  nativeOauthHandoffCodeSchema,
} from "@/lib/native-oauth";

type ReturnPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function NativeOauthReturnPage({
  searchParams,
}: ReturnPageProps) {
  const params = await searchParams;
  const attempt = nativeOauthAttemptIdSchema.safeParse(single(params.attempt));
  const code = nativeOauthHandoffCodeSchema.safeParse(single(params.code));
  const status = nativeOauthFailureCodeSchema.safeParse(single(params.status));
  const hasOneResult = Number(code.success) + Number(status.success) === 1;
  const valid = attempt.success && hasOneResult;
  let openUrl: string | null = null;
  if (valid) {
    const url = new URL("ai.alook://auth/native/return");
    url.searchParams.set("attempt", attempt.data);
    if (code.success) url.searchParams.set("code", code.data);
    if (status.success) url.searchParams.set("status", status.data);
    openUrl = url.toString();
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-sm space-y-4 text-center">
        <h1 className="text-2xl font-semibold">Return to Alook</h1>
        <p className="text-sm text-muted-foreground">
          {openUrl
            ? "Continue in the Alook app to finish this sign-in."
            : "This sign-in link is invalid or has expired."}
        </p>
        {openUrl ? (
          <a
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            href={openUrl}
          >
            Open Alook
          </a>
        ) : null}
      </section>
    </main>
  );
}
