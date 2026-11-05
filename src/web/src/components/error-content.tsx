"use client";

import Link from "next/link";
import technostalgia from "@/components/brand/technostalgia.module.css";
import { Button, buttonVariants } from "@/components/ui/button";
import { TypewriterVisual } from "@/components/typewriter-visual";

export function ErrorContent({
	reset,
	hardHomeNavigation = false,
}: {
	reset: () => void;
	hardHomeNavigation?: boolean;
}) {
	const homeClassName = buttonVariants({ variant: "secondary", size: "lg", className: "h-11 px-5" });

	return (
		<div
			className={`${technostalgia.theme} landing flex flex-1 flex-col items-center justify-center px-6`}
			style={{ backgroundColor: "var(--background)" }}
		>
			<div className="w-full max-w-md">
				<TypewriterVisual
					entranceDelay={0.3}
					paper={
						<>
							<div
								className="tw-email-headers"
								style={{
									fontFamily: "var(--font-sans)",
									fontSize: "15px",
									color: "var(--tn-ink, #1f1a15)",
									lineHeight: 1.7,
									borderBottom: "1px solid oklch(0.15 0.01 55 / 10%)",
									paddingBottom: "10px",
									marginBottom: "12px",
								}}
							>
								<div className="tw-email-line"><span style={{ color: "var(--tn-ink, #1f1a15)" }}>From:</span>{" "}system@alook.ai</div>
								<div className="tw-email-line"><span style={{ color: "var(--tn-ink, #1f1a15)" }}>To:</span>{" "}you</div>
								<div className="tw-email-line"><span style={{ color: "var(--tn-ink, #1f1a15)" }}>Subject:</span>{" "}Something went wrong</div>
							</div>
							<div
								className="tw-email-body"
								style={{
									fontFamily: "var(--font-sans)",
									color: "var(--tn-ink, #1f1a15)",
									fontSize: "17px",
									lineHeight: 1.6,
								}}
							>
								An unexpected error occurred. Our team has been notified. You can try again or head back home.
							</div>
						</>
					}
				/>
			</div>
			<div className="mt-8 flex items-center gap-4">
				<Button onClick={reset} size="lg" className="h-11 px-5">
					Try again
				</Button>
				{hardHomeNavigation ? (
					// This component also renders inside the independently routed Blog Worker.
					// eslint-disable-next-line @next/next/no-html-link-for-pages
					<a href="/" data-variant="secondary" data-size="lg" className={homeClassName}>Go home</a>
				) : (
					<Link href="/" data-variant="secondary" data-size="lg" className={homeClassName}>Go home</Link>
				)}
			</div>
		</div>
	);
}
