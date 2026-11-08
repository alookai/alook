import { mkdir, readdir } from 'node:fs/promises'

export async function prepareRunDirectory(outDir) {
  await mkdir(outDir, { recursive: true })
  if ((await readdir(outDir)).length) throw new Error('Output directory must be empty; preserve each run separately')
}
