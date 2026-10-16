import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Joined so this file is not itself a hit of the previous application id.
const oldId = ['com', 'nousresearch', 'hermesagent', 'mobile'].join('.')
const root = fileURLToPath(new URL('..', import.meta.url))
const skipDirNames = new Set(['node_modules', '.git', 'dist', '.gradle'])

function posix(rel) {
  return sep === '/' ? rel : rel.split(sep).join('/')
}

// Gradle's app-module output, e.g. apps/mobile/android/app/build/...
// A directory that is merely named "build" is still scanned.
function isAndroidAppBuild(relPosix) {
  const parts = relPosix.split('/')
  for (let i = 0; i + 2 < parts.length; i++) {
    if (parts[i] === 'android' && parts[i + 1] === 'app' && parts[i + 2] === 'build') return true
  }
  return false
}

// Editor and copy backups under planning/ (issues.md~, issues.json.bak, …).
function isPlanningBackup(relPosix) {
  if (relPosix !== 'planning' && !relPosix.startsWith('planning/')) return false
  const name = relPosix.slice(relPosix.lastIndexOf('/') + 1)
  if (name.endsWith('~') || name.endsWith('.bak') || name.endsWith('.backup') || name.endsWith('.orig') || name.endsWith('.old')) return true
  if (name.endsWith('.swp') || name.endsWith('.swo') || name.startsWith('.#')) return true
  if (name.startsWith('#') && name.endsWith('#')) return true
  return false
}

function walk(dir, hits) {
  for (const name of readdirSync(dir)) {
    if (skipDirNames.has(name)) continue
    const path = join(dir, name)
    const rel = posix(relative(root, path))
    if (isAndroidAppBuild(rel) || isPlanningBackup(rel)) continue
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
