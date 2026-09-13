import { writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function generateAdapter(entry, output) {
  const target = resolve(entry)
  const observer = fileURLToPath(new URL('./worker-observer.mjs', import.meta.url))
  await mkdir(dirname(resolve(output)), { recursive: true })
  await writeFile(output, `import worker from ${JSON.stringify(target)}\nimport { observeWorker } from ${JSON.stringify(observer)}\nexport * from ${JSON.stringify(target)}\nexport default observeWorker(worker)\n`)
}
