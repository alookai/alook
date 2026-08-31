"use client";

import { ErrorContent } from "@/components/error-content";

export default function Error({
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	return <ErrorContent reset={reset} />;
}
