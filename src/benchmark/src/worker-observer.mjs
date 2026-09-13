import { observeD1 } from './d1-observer.mjs'

export function observeWorker(worker, emit = event => console.log(JSON.stringify(event))) {
  return {
    ...worker,
    async fetch(request, env, context) {
      const requestId = request.headers.get('x-alook-benchmark-id')
      if (!requestId || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) return worker.fetch(request, env, context)
      const started = performance.now()
      let responded = false
      const tasks = []
      const write = event => {
        try { emit({ benchmark: 1, requestId, ...event }) } catch {}
      }
      const observedEnv = new Proxy(env, {
        get(target, key) { return key === 'DB' ? db : Reflect.get(target, key, target) },
      })
      const db = observeD1(env.DB, event => write({ ...event, startedMs: event.startedMs - started }), () => performance.now(), () => responded)
      const observedContext = new Proxy(context, {
        get(target, key) {
          if (key === 'waitUntil') return task => {
            const settled = Promise.resolve(task).then(() => true, () => false)
            tasks.push(settled)
            target.waitUntil(task)
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      write({ kind: 'request-start' })
      try {
        const response = await worker.fetch(request, observedEnv, observedContext)
        write({ kind: 'response', status: response.status, wallMs: performance.now() - started })
        return response
      } finally {
        responded = true
        context.waitUntil((async () => {
          let consumed = 0
          let failedTasks = 0
          while (consumed < tasks.length) {
            const batch = tasks.slice(consumed)
            consumed += batch.length
            failedTasks += (await Promise.all(batch)).filter(ok => !ok).length
          }
          write({ kind: 'request-complete', backgroundTasks: consumed, failedTasks, wallMs: performance.now() - started })
        })())
      }
    },
  }
}
