#!/usr/bin/env node
/** Bundles and runs the pure-JS renderer mux-model/reducer tests under plain node. */
const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const outfile = path.join(root, '.test', 'test-mux.cjs')

async function main() {
  fs.mkdirSync(path.dirname(outfile), { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'test-mux.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'error'
  })
  execFileSync(process.execPath, [outfile], { stdio: 'inherit' })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
