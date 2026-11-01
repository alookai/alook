"use client";

import { DeferredBlogError } from "@blog/components/deferred-blog-failure";

export default function BlogError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
	return <DeferredBlogError reset={reset} />;
}
