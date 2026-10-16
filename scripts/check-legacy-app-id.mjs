import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Joined so this file is not itself a hit of the previous application id.
const oldId = ['com', 'nousresearch', 'hermesagent', 'mobile'].join('.')
const root = fileURLToPath(new URL('..', import.meta.url))
const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.gradle'])

function walk(dir, hits) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      walk(path, hits)
      continue
    }
    if (!stat.isFile() || stat.size > 2_000_000) continue
    const bytes = readFileSync(path)
    if (bytes.includes(0)) continue
    const text = bytes.toString('utf8')
    if (!text.includes(oldId)) continue
    const rel = relative(root, path)
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(oldId)) hits.push(`${rel}:${i + 1}:${lines[i]}`)
    }
  }
}

const hits = []
walk(root, hits)
if (hits.length === 0) console.log('(no hits)')
else for (const hit of hits) console.log(hit)

const ok = hits.length === 1 && hits[0].startsWith('README.md:')
if (!ok) {
  console.error(`expected exactly one hit, in README.md; found ${hits.length}`)
  process.exit(1)
}
