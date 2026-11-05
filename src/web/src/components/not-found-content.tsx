import Link from "next/link";
import technostalgia from "@/components/brand/technostalgia.module.css";
import { buttonVariants } from "@/components/ui/button";
import { TypewriterVisual } from "@/components/typewriter-visual";

export function NotFoundContent({ hardHomeNavigation = false }: { hardHomeNavigation?: boolean }) {
	const className = buttonVariants({ size: "lg", className: "mt-8 h-11 px-5" });
	const content = (
		<>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
				<path d="M19 12H5M12 19l-7-7 7-7" />
			</svg>
			Go home
		</>
	);

	return (
		<div className={`${technostalgia.theme} landing flex flex-1 flex-col items-center justify-center px-6`} style={{ backgroundColor: "var(--background)" }}>
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
								<div className="tw-email-line"><span style={{ color: "var(--tn-ink, #1f1a15)" }}>From:</span>{" "}postmaster@alook.ai</div>
								<div className="tw-email-line"><span style={{ color: "var(--tn-ink, #1f1a15)" }}>To:</span>{" "}you</div>
								<div className="tw-email-line"><span style={{ color: "var(--tn-ink, #1f1a15)" }}>Subject:</span>{" "}Undeliverable — page not found</div>
							</div>
							<div className="tw-email-body" style={{ fontFamily: "var(--font-sans)", color: "var(--tn-ink, #1f1a15)", fontSize: "17px", lineHeight: 1.6 }}>
								The page you&#39;re looking for doesn&#39;t exist or has been moved. Check the address and try again.
							</div>
						</>
					}
				/>
			</div>
			{hardHomeNavigation ? (
				// This component also renders inside the independently routed Blog Worker.
				// eslint-disable-next-line @next/next/no-html-link-for-pages
				<a href="/" data-variant="default" data-size="lg" className={className}>{content}</a>
			) : (
				<Link href="/" data-variant="default" data-size="lg" className={className}>{content}</Link>
			)}
		</div>
	);
}
