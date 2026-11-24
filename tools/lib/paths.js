import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The repository root (tools/lib/../..). Built with fileURLToPath so paths
// containing spaces or %-escapes resolve correctly.
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// True when the module at `importMetaUrl` is the script node was started with.
export function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(importMetaUrl))
  } catch {
    return false
  }
}
