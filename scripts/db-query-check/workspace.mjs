import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { workspacePackageRoots } from '../workspace-packages.mjs'

export function verifyWorkspaceDependencies(root) {
  const packages = workspacePackageRoots(root).map(directory => ({ directory, ...JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8')) }))
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]))
  if (!packages.length || byName.size !== packages.length) throw new Error('Workspace manifest must identify distinct local packages')
  const links = []
  const failures = []
  for (const pkg of packages) {
    const require = createRequire(resolve(root, pkg.directory, 'package.json'))
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }
    for (const name of Object.keys(dependencies).filter(name => byName.has(name))) {
      const expected = byName.get(name).directory
      const actual = (require.resolve.paths(name) ?? []).map(directory => resolve(directory, name)).find(directory => existsSync(resolve(directory, 'package.json')))
      if (!actual) failures.push(`${pkg.directory}: missing workspace dependency ${name}`)
      else if (realpathSync(actual) !== realpathSync(resolve(root, expected))) failures.push(`${pkg.directory}: ${name} resolves to ${realpathSync(actual)}, expected this worktree's ${expected}`)
      else links.push({ consumer: pkg.directory, dependency: name, target: expected })
    }
  }
  if (failures.length) throw new Error(`Mixed or incomplete workspace dependencies; install dependencies in this worktree before checking SQL. Shared external package stores are allowed.\n${failures.join('\n')}`)
  return links
}
