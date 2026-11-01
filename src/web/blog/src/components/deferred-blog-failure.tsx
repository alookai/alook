"use client";

import dynamic from "next/dynamic";
import { Component, type ReactNode } from "react";
import { ZoneLink } from "@/components/public-layout";

function FailureText({ missing = false }: { missing?: boolean }) {
  return <div className="mx-auto flex max-w-xl flex-1 flex-col justify-center gap-6 px-6 py-24">
    <h1 className="text-3xl font-semibold">{missing ? "Page not found" : "Something went wrong"}</h1>
    <p className="text-muted-foreground">{missing ? "Check the address and try again." : "Try again or head back home."}</p>
    <ZoneLink href="/" zone="blog" className="underline underline-offset-4">Go home</ZoneLink>
  </div>;
}

export class BlogFailureBoundary extends Component<{ children: ReactNode; missing?: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <FailureText missing={this.props.missing} /> : this.props.children; }
}

const MissingContent = dynamic(() => import("@/components/not-found-content").then((module) => module.NotFoundContent), {
  ssr: false,
  loading: () => <FailureText missing />,
});
const FailedContent = dynamic(() => import("@/components/error-content").then((module) => module.ErrorContent), {
  ssr: false,
  loading: () => <FailureText />,
});

export function DeferredBlogNotFound() {
  return <BlogFailureBoundary missing><MissingContent hardHomeNavigation /></BlogFailureBoundary>;
}
export function DeferredBlogError({ reset }: { reset: () => void }) {
  return <BlogFailureBoundary><FailedContent reset={reset} hardHomeNavigation /></BlogFailureBoundary>;
}
