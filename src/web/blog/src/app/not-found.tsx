import type { Metadata } from "next";
import { DeferredBlogNotFound } from "@blog/components/deferred-blog-failure";

export const metadata: Metadata = {
	title: "Page Not Found",
	description: "The page you're looking for doesn't exist or has been moved.",
	robots: { index: false, follow: true },
};

export default function BlogNotFound() {
	return <DeferredBlogNotFound />;
}
