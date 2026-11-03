export interface OpenNextWorkerHandler<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>
}
