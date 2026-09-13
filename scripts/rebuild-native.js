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

/**
 * ssh2's optional native helper `cpu-features` ships a `binding.gyp` that
 * includes `buildcheck.gypi`. That file is produced by its own npm `install`
 * script (`node buildcheck.js > buildcheck.gypi`), but @electron/rebuild only
 * runs node-gyp and never re-runs that step. If npm skipped/cleaned the file
 * (e.g. because the initial optional-dependency build failed), node-gyp aborts
 * with "buildcheck.gypi not found". Regenerate it up front so the rebuild can
 * proceed. cpu-features is optional: ssh2 falls back to a pure-JS
 * implementation, so a failure here must not abort the whole install.
 */
function prepareCpuFeatures() {
  const dir = path.join(root, 'node_modules', 'cpu-features')
  const script = path.join(dir, 'buildcheck.js')
  const gypi = path.join(dir, 'buildcheck.gypi')
  if (!fs.existsSync(script) || fs.existsSync(gypi)) return

  // `buildcheck.js` probes the compiler to detect headers/features. The zig
  // toolchain env vars (`CC="zig cc"` etc.) confuse that probe, so run it with
  // a clean compiler environment.
  const env = { ...process.env }
  for (const k of ['CC', 'CXX', 'AR', 'RANLIB']) delete env[k]
  const r = spawnSync(process.execPath, ['buildcheck.js'], { cwd: dir, encoding: 'utf8', env })
  if (r.status === 0 && r.stdout && r.stdout.trim()) {
    fs.writeFileSync(gypi, r.stdout)
    console.log('[rebuild] generated cpu-features/buildcheck.gypi')
  } else {
    console.log('[rebuild] could not generate cpu-features/buildcheck.gypi (optional, ignoring)')
  }
}

/**
 * Electron >= 44 no longer ships a `postinstall` script, so `npm install` never
 * downloads the platform binary. electron-vite reads
 * `node_modules/electron/path.txt` directly (it does not trigger electron's
 * lazy runtime download) and aborts with "Error: Electron uninstall" when the
 * binary is absent. Download it here so `npm install` fully prepares the app.
 */
function readNpmrc(key) {
  try {
    const txt = fs.readFileSync(path.join(root, '.npmrc'), 'utf8')
    const m = txt.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.+?)\\s*$', 'm'))
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

function ensureElectron() {
  const dir = path.join(root, 'node_modules', 'electron')
  const installer = path.join(dir, 'install.js')
  if (!fs.existsSync(installer)) return

  const pathFile = path.join(dir, 'path.txt')
  let installed = false
  if (fs.existsSync(pathFile)) {
    const rel = fs.readFileSync(pathFile, 'utf8').trim()
    installed = rel.length > 0 && fs.existsSync(path.join(dir, 'dist', rel))
  }
  if (installed) return

  const env = { ...process.env }
  // electron's installer reads ELECTRON_MIRROR / npm_config_electron_mirror,
  // but npm 12 no longer reliably forwards unknown .npmrc keys.
  if (!env.ELECTRON_MIRROR && !env.npm_config_electron_mirror) {
    env.ELECTRON_MIRROR = readNpmrc('electron_mirror') || 'https://github.com/electron/electron/releases/download/'
  }

  console.log('[rebuild] electron binary missing; downloading...')
  const r = spawnSync(process.execPath, [installer], { stdio: 'inherit', env })
  if (r.status !== 0) {
    console.log('[rebuild] electron download failed; run "npx install-electron" manually')
  }
}

function electronVersion() {
  try {
    return require(path.join(root, 'node_modules', 'electron', 'package.json')).version
  } catch {
    return require(path.join(root, 'package.json')).devDependencies.electron.replace(/^[^0-9]*/, '')
  }
}

ensurePython()
prepareCpuFeatures()
ensureElectron()

if (patchNodePtySpectre()) {
  // Force node-gyp to regenerate the project files from the patched gyp.
  const buildDir = path.join(root, 'node_modules', 'node-pty', 'build')
  fs.rmSync(buildDir, { recursive: true, force: true })
}

const spawnOpts = {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env
}

// Resolve the electron-builder bin (hoisted under node_modules/.bin)
const bin = path.join(root, 'node_modules', '.bin', 'electron-builder')
let r = spawnSync(bin, ['install-app-deps'], spawnOpts)

// electron-builder rebuilds *all* native deps and aborts on the first failure.
// If it failed, retry the one native module we actually need (node-pty) so an
// optional module (cpu-features) cannot break the install.
if (r.status !== 0) {
  console.log('[rebuild] install-app-deps failed; retrying required native module (node-pty) only')
  const electronRebuild = path.join(root, 'node_modules', '.bin', 'electron-rebuild')
  r = spawnSync(
    electronRebuild,
    ['-v', electronVersion(), '-o', 'node-pty', '-f'],
    spawnOpts
  )
}

process.exit(r.status ?? 1)
