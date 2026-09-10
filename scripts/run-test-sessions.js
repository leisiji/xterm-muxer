#!/usr/bin/env node
/**
 * Builds scripts/test-sessions.ts and runs it under the Electron binary
 * (no window needed) so that the node-pty module compiled for Electron's ABI
 * can be exercised. ssh-config / known-hosts / parseTarget are pure JS and
 * run under the same harness.
 */
const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const outDir = path.join(root, '.test')
const outfile = path.join(outDir, 'test-sessions.cjs')

async function main() {
  fs.mkdirSync(outDir, { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'test-sessions.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['electron', 'node-pty', 'ssh2'],
    logLevel: 'error'
  })
  const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron')
  execFileSync(
    electron,
    [outfile, '--no-sandbox', '--disable-gpu', '--ozone-platform=headless'],
    { stdio: 'inherit', env: { ...process.env } }
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
