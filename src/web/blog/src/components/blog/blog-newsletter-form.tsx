"use client";

import { useState, type SubmitEvent } from "react";
import { ZoneLink } from "@/components/public-layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Cassette } from "@/components/brand/retro-objects";
import technostalgia from "@/components/brand/technostalgia.module.css";
import { trackBlogNewsletterSubscribed } from "@/lib/analytics";
import type { BlogNewsletterPlacement } from "@/lib/product-analytics-contract";
import { cn } from "@/lib/utils";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "subscribed"; message: string }
  | { kind: "error"; message: string };

export function BlogNewsletterForm({
  placement = "end",
  slug,
}: {
  placement?: BlogNewsletterPlacement;
  slug?: string;
}) {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  const emailId = `blog-newsletter-email-${placement}`;
  const websiteId = `blog-newsletter-website-${placement}`;
  const statusId = `blog-newsletter-status-${placement}`;

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setState({ kind: "error", message: "Enter an email address." });
      return;
    }

    setState({ kind: "submitting" });
    try {
      const response = await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: trimmed,
          website,
          placement,
          slug,
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { status?: string; error?: string }
        | null;

      if (response.ok) {
        const already = payload?.status === "already_subscribed";
        if (!already) {
          trackBlogNewsletterSubscribed({
            placement,
            sourcePath: slug ? `/blog/${slug}` : undefined,
          });
        }
        setEmail("");
        setState({
          kind: "subscribed",
          message: already
            ? "You're already on the list."
            : "Subscribed. Monthly notes are on the way.",
        });
        return;
      }

      if (response.status === 429) {
        setState({
          kind: "error",
          message: "Too many attempts. Try again later.",
        });
        return;
      }

      if (response.status === 400) {
        setState({
          kind: "error",
          message: payload?.error || "Enter a valid email address.",
        });
        return;
      }

      setState({
        kind: "error",
        message: "Subscription is temporarily unavailable. Try again shortly.",
      });
    } catch {
      setState({
        kind: "error",
        message: "Network error. Please try again.",
      });
    }
  };

  return (
    <section
      aria-label="Alook Blog Newsletter"
      data-testid={`blog-newsletter-${placement}`}
      className={technostalgia.theme}
    >
      <Card className="gap-3 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-xs text-muted-foreground">
              Newsletter
            </p>
            <p className="mt-1 font-sans text-base font-semibold tracking-tight text-foreground">
              Get monthly multi-agent engineering notes.
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Practical workflows for Claude Code, Codex, and shared human-agent rooms.
            </p>
          </div>
          <Cassette className="mt-0.5 hidden h-7 w-auto shrink-0 -rotate-3 sm:block" />
        </div>

        <form
          onSubmit={handleSubmit}
          noValidate
          className="mt-1 flex flex-col gap-2.5 sm:flex-row sm:items-center"
        >
          <label htmlFor={emailId} className="sr-only">
            Email address
          </label>
          <Input
            id={emailId}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (state.kind !== "idle") setState({ kind: "idle" });
            }}
            placeholder="you@example.com"
            disabled={state.kind === "submitting"}
            aria-invalid={state.kind === "error" || undefined}
            aria-describedby={state.kind === "error" || state.kind === "subscribed" ? statusId : undefined}
            className="h-9 px-3 text-sm sm:flex-1"
          />

          <div className="sr-only" aria-hidden="true">
            <label htmlFor={websiteId}>Website</label>
            <input
              id={websiteId}
              name="website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>

          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={state.kind === "submitting"}
            className="h-9 w-full px-5 text-xs sm:w-auto sm:shrink-0"
          >
            {state.kind === "submitting" ? "Subscribing…" : "Subscribe"}
          </Button>
        </form>

        {(state.kind === "subscribed" || state.kind === "error") && (
          <p
            id={statusId}
            role={state.kind === "error" ? "alert" : "status"}
            className={cn(
              "text-xs leading-snug",
              state.kind === "error"
                ? "text-destructive"
                : "text-emerald-700 dark:text-emerald-400",
            )}
          >
            {state.message}
          </p>
        )}

        <p className="text-[11px] text-muted-foreground">
          No spam.{" "}
          <ZoneLink href="/privacy" zone="blog" className="underline underline-offset-2 hover:text-foreground">
            Privacy
          </ZoneLink>
        </p>
      </Card>
    </section>
  );
}
