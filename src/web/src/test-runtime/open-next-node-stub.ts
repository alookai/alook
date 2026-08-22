export class DOQueueHandler {}

const openNextNodeStub = {
  async fetch(): Promise<Response> {
    return new Response("node-open-next", {
      headers: { "x-open-next": "node-stub" },
    })
  },
}

export default openNextNodeStub
