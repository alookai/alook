export class DOQueueHandler {}

const openNextNodeStub = {
	async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname === "/internal/blog-discovery") {
			return Response.json({ version: 1, posts: [] })
		}
		return new Response("node-open-next", {
      headers: { "x-open-next": "node-stub" },
    })
  },
}

export default openNextNodeStub
