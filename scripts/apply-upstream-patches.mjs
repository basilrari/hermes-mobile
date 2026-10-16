#!/usr/bin/env node
/**
 * apply-upstream-patches.mjs — apply (or verify) the carried upstream patches
 * (HM-16).
 *
 * `patches/upstream/*.patch` hold fixes the mobile build needs before they land
 * in NousResearch/hermes-agent. This script is the single place they are applied,
 * so CI can fail the moment one stops applying (a resync or an upstream change
 * moved the context — rebase it, HM-33).
 *
 *   node scripts/apply-upstream-patches.mjs             # apply every patch
 *   node scripts/apply-upstream-patches.mjs --check      # verify only, no writes
 *   node scripts/apply-upstream-patches.mjs --self-test  # prove the mechanism
 *
 * Exit 0 when every patch applies (or the directory is empty). Exit 1 with the
 * failing patch named otherwise. Exit 2 on a bad invocation.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_PATCH_DIR = path.join(repoRoot, 'patches', 'upstream')

/** Sorted `*.patch` files in `dir` (empty array when the dir is absent). */
export function listPatches(dir = DEFAULT_PATCH_DIR) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.patch'))
    .sort()
    .map((name) => path.join(dir, name))
}

/**
 * Apply or check every patch. Returns { total, failed: [{ file, stderr }] }.
 * Never throws for a patch that fails to apply — the caller reports it.
 */
export function applyPatches(dir = DEFAULT_PATCH_DIR, { check = false, cwd = repoRoot, log = () => {} } = {}) {
  const files = listPatches(dir)
  const failed = []
  for (const file of files) {
    const args = ['apply', ...(check ? ['--check'] : []), file]
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    const name = path.basename(file)
    if (result.status !== 0) {
      const stderr = (result.stderr || result.stdout || '').trim()
      failed.push({ file, stderr })
      log(`✗ ${name}${check ? ' (check)' : ''}: ${stderr.split('\n')[0]}`)
    } else {
      log(`✓ ${name}${check ? ' (check)' : ''}`)
    }
  }
  return { total: files.length, failed }
}

/** Create a throwaway git repo with one committed file; returns its path. */
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-patch-selftest-'))
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  git('init', '-q')
  git('config', 'user.email', 'selftest@example.invalid')
  git('config', 'user.name', 'selftest')
  fs.writeFileSync(path.join(dir, 'target.txt'), 'alpha\nbeta\ngamma\n')
  git('add', 'target.txt')
  git('commit', '-qm', 'base')
  return { dir, git }
}

/**
 * Prove both directions: a patch that applies passes `--check`, and the same
 * patch fails `--check` once it is already applied (a stale carry).
 */
export function selfTest() {
  const { dir, git } = tmpRepo()
  const patchDir = path.join(dir, 'patches')
  fs.mkdirSync(patchDir)
  try {
    fs.writeFileSync(path.join(dir, 'target.txt'), 'alpha\nbeta-changed\ngamma\n')
    fs.writeFileSync(path.join(patchDir, 'selftest.patch'), git('diff'))
    git('checkout', '--', 'target.txt')

    const pass = applyPatches(patchDir, { check: true, cwd: dir })
    if (pass.total !== 1 || pass.failed.length !== 0) {
      throw new Error(`self-test: a fresh patch should check clean, got ${JSON.stringify(pass.failed)}`)
    }

    applyPatches(patchDir, { cwd: dir }) // actually apply it
    const stale = applyPatches(patchDir, { check: true, cwd: dir })
    if (stale.failed.length !== 1) {
      throw new Error('self-test: a stale patch must fail --check, but it passed')
    }

    console.log('self-test: PASS (fresh patch checks clean, stale patch fails)')
    return true
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) {
    selfTest()
    return
  }
  const check = args.includes('--check')
  const unknown = args.filter((a) => a !== '--check')
  if (unknown.length) {
    console.error(`unknown argument(s): ${unknown.join(' ')}`)
    process.exit(2)
  }

  const { total, failed } = applyPatches(DEFAULT_PATCH_DIR, { check, log: console.log })
  if (failed.length) {
    console.error(`\n${failed.length}/${total} patch(es) do not apply. Rebase them on the pinned SHA (HM-33).`)
    process.exit(1)
  }
  console.log(total === 0 ? 'no carried patches (nothing to do)' : `\n${total}/${total} patch(es) ${check ? 'check clean' : 'applied'}`)
}

// Only run as a CLI (the exports are used by tests/other scripts).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
}
