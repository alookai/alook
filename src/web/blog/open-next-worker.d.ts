declare module "*/.open-next/worker.js" {
	const handler: {
		fetch(
			request: Request,
			env: BlogCloudflareEnv,
			ctx: ExecutionContext,
		): Response | Promise<Response>;
	};

	export default handler;
}
