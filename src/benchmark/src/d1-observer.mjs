function encodeBinary(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function jsonBytes(value) {
  try { return new TextEncoder().encode(JSON.stringify(value, (_key, item) => item instanceof ArrayBuffer ? { binaryBase64: encodeBinary(new Uint8Array(item)) } : ArrayBuffer.isView(item) ? { binaryBase64: encodeBinary(new Uint8Array(item.buffer, item.byteOffset, item.byteLength)) } : item)).byteLength } catch { return null }
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function observeD1(database, emit, clock = () => performance.now(), phase = () => false) {
  const originals = new WeakMap()
  let operation = 0
  function statement(target, sqlBytes, parameterBytes = 0) {
    const wrapped = new Proxy(target, {
      get(object, key) {
        if (key === 'bind') return (...values) => statement(object.bind(...values), sqlBytes, jsonBytes(values))
        if (['all', 'run', 'raw', 'first'].includes(key)) {
          return (...args) => execute(key, 1, sqlBytes, parameterBytes, () => object[key](...args))
        }
        const value = Reflect.get(object, key, object)
        return typeof value === 'function' ? value.bind(object) : value
      },
    })
    originals.set(wrapped, { target, sqlBytes, parameterBytes })
    return wrapped
  }
  async function execute(method, statements, sqlBytes, parameterBytes, run) {
    const id = ++operation
    const started = clock()
    const startedAfterResponse = phase()
    let result
    let ok = false
    try {
      result = await run()
      ok = true
      return result
    } finally {
      const elapsed = clock() - started
      const results = method === 'batch' ? (Array.isArray(result) ? result : []) : [result]
      const metadata = results.map(value => {
        const meta = ['all', 'run', 'batch'].includes(method) && value && !Array.isArray(value) ? value.meta : undefined
        return {
          sqlDurationMs: numeric(meta?.timings?.sql_duration_ms ?? meta?.duration),
          internalAttempts: numeric(meta?.total_attempts), rowsRead: numeric(meta?.rows_read), rowsWritten: numeric(meta?.rows_written),
        }
      })
      try {
        emit({ kind: 'd1', operation: id, method, statements, reportedExecCount: method === 'exec' && ok ? numeric(result?.count) : null, ok, startedMs: started, startedAfterResponse, completedAfterResponse: phase(),
          wallMs: elapsed, sqlBytes, parameterJsonBytes: parameterBytes,
          resultJsonBytes: result === undefined ? null : jsonBytes(result), metadata })
      } catch {}
    }
  }
  function binding(target) {
    return new Proxy(target, {
      get(object, key) {
        if (key === 'prepare') return sql => statement(object.prepare(sql), new TextEncoder().encode(sql).byteLength)
        if (key === 'withSession') return (...args) => binding(object.withSession(...args))
        if (key === 'batch') return statements => {
          const entries = statements.map(item => originals.get(item))
          if (entries.some(item => !item)) throw new Error('D1 batch contains a statement outside this observer')
          return execute('batch', statements.length,
            entries.reduce((sum, item) => sum + item.sqlBytes, 0),
            entries.some(item => item.parameterBytes === null) ? null : entries.reduce((sum, item) => sum + item.parameterBytes, 0),
            () => object.batch(entries.map(item => item.target)))
        }
        if (key === 'exec') return sql => execute('exec', null, new TextEncoder().encode(sql).byteLength, 0, () => object.exec(sql))
        const value = Reflect.get(object, key, object)
        return typeof value === 'function' ? value.bind(object) : value
      },
    })
  }
  return binding(database)
}
