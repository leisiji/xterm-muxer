#!/usr/bin/env node
/**
 * Rebuild native modules for Electron.
 *
 * Two environments are supported:
 *  - Linux dev box: system g++ (7.5) cannot build C++20, so node-pty is
 *    compiled with a portable zig toolchain (bundled clang + libc++). If zig
 *    is not found we fall back to the default toolchain.
 *  - Windows: MSVC (Visual Studio) is used. node-gyp also needs a real Python
 *    3.8+ interpreter; the script points it at one if the shell PATH only
 *    exposes the Microsoft Store stub.
 *
 * Common Windows pitfall: node-pty's binding.gyp requests Spectre-mitigated
 * libraries, which are an optional Visual Studio component that is frequently
 * missing, causing "error MSB8040". We build without the mitigation (it is a
 * hardening flag, not a functional requirement) so the module builds with the
 * base toolchain.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(__dirname, '..')

function findZig() {
  const candidates = [
    process.env.ZIG_PATH,
    '/home/tftpboot/jaron.ye/zig160/zig',
    path.join(os.homedir(), 'zig160', 'zig')
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  // check PATH
  const which = spawnSync('which', ['zig'], { encoding: 'utf8' })
  if (which.status === 0) return which.stdout.trim()
  return null
}

function ensurePython() {
  if (process.env.NODE_GYP_FORCE_PYTHON || process.env.PYTHON) return

  const candidates = process.platform === 'win32'
    ? [
        process.env.PYTHON_HOME ? path.join(process.env.PYTHON_HOME, 'python.exe') : null,
        'D:\\Python312\\python.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
        'C:\\Python312\\python.exe',
        'C:\\Python311\\python.exe'
      ].filter(Boolean)
    : ['python3', 'python']

  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' })
    if (r.status === 0 && (r.stdout || '').trim() === '3') {
      process.env.PYTHON = c
      console.log(`[rebuild] using Python: ${c}`)
      return
    }
  }
  console.log('[rebuild] no usable Python found; letting node-gyp auto-detect')
}

/**
 * Disable Spectre mitigation in node-pty's gyp files (Windows only).
 * @returns {boolean} true if any file was modified
 */
function patchNodePtySpectre() {
  if (process.platform !== 'win32') return false

  const files = [
    path.join(root, 'node_modules', 'node-pty', 'binding.gyp'),
    path.join(root, 'node_modules', 'node-pty', 'deps', 'winpty', 'src', 'winpty.gyp')
  ]

  let changed = false
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const src = fs.readFileSync(file, 'utf8')
    const patched = src.replace(
      /(['"]SpectreMitigation['"]\s*:\s*)['"]Spectre['"]/g,
      "$1'false'"
    )
    if (patched !== src) {
      fs.writeFileSync(file, patched)
      console.log(`[rebuild] disabled Spectre mitigation in ${path.relative(root, file)}`)
      changed = true
    }
  }
  return changed
}

const zig = findZig()
if (zig) {
  console.log(`[rebuild] using zig toolchain: ${zig}`)
  process.env.CC = `${zig} cc`
  process.env.CXX = `${zig} c++`
  process.env.AR = `${zig} ar`
  process.env.RANLIB = `${zig} ranlib`
} else {
  console.log('[rebuild] zig not found; using default toolchain')
}

ensurePython()

if (patchNodePtySpectre()) {
  // Force node-gyp to regenerate the project files from the patched gyp.
  const buildDir = path.join(root, 'node_modules', 'node-pty', 'build')
  fs.rmSync(buildDir, { recursive: true, force: true })
}

// Resolve the electron-builder bin (hoisted under node_modules/.bin)
const bin = path.join(root, 'node_modules', '.bin', 'electron-builder')
const r = spawnSync(bin, ['install-app-deps'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env
})
process.exit(r.status ?? 1)
