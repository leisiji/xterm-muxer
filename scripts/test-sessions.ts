/**
 * Headless smoke test for the main-process session layer.
 * Run:  node scripts/run-test-sessions.js   (builds then runs under electron, no window)
 */
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { app } from 'electron'
import { Server, utils } from 'ssh2'
import { parseTarget, resolveSshConfig, listSshHosts } from '../src/main/sessions/ssh-config'
import { checkKnownHost, addKnownHost, fingerprint, keyTypeOf } from '../src/main/sessions/known-hosts'
import { SessionManager } from '../src/main/sessions/session-manager'
import { defaultShell } from '../src/main/sessions/local-session'

let passed = 0
function ok(name: string): void {
  passed++
  console.log(`  ok - ${name}`)
}

function makeKeyBlob(offset = 0): Buffer {
  const alg = Buffer.from('ssh-ed25519')
  const payload = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) payload[i] = (i * 7 + 3 + offset) & 0xff
  const blob = Buffer.alloc(4 + alg.length + 4 + payload.length)
  blob.writeUInt32BE(alg.length, 0)
  alg.copy(blob, 4)
  blob.writeUInt32BE(payload.length, 4 + alg.length)
  payload.copy(blob, 4 + alg.length + 4)
  return blob
}

function testParseTarget(): void {
  console.log('parseTarget')
  assert.strictEqual(parseTarget('host').host, 'host')
  assert.strictEqual(parseTarget('user@host').user, 'user')
  assert.strictEqual(parseTarget('user@host:2222').host, 'host')
  assert.strictEqual(parseTarget('user@host:2222').port, 2222)
  assert.strictEqual(parseTarget('[::1]:2222').host, '::1')
  assert.strictEqual(parseTarget('[::1]:2222').port, 2222)
  ok('parseTarget')
}

function testSshConfig(): void {
  console.log('ssh-config')
  const home = os.homedir()
  const cfgDir = path.join(home, '.ssh')
  fs.mkdirSync(cfgDir, { recursive: true })
  const cfgPath = path.join(cfgDir, 'config')
  const orig = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : null
  fs.writeFileSync(
    cfgPath,
    [
      'Host *',
      '  ServerAliveInterval 30',
      '',
      'Host github',
      '  HostName github.com',
      '  User git',
      '  IdentityFile ~/.ssh/github_key',
      '',
      'Host web-db',
      '  Port 2223',
      '',
      'Host web*',
      '  Port 2222',
      '',
      'Match host corphost user alice',
      '  Port 3000'
    ].join('\n')
  )

  const github = resolveSshConfig('github')
  assert.strictEqual(github.host, 'github.com')
  assert.strictEqual(github.user, 'git')
  assert.ok(github.identityFiles.includes(path.join(home, '.ssh', 'github_key')), 'identity file resolved')
  assert.strictEqual(github.serverAliveInterval, 30)
  assert.strictEqual(github.port, 22)
  ok('github block resolved')

  const webFoo = resolveSshConfig('web-foo')
  assert.strictEqual(webFoo.port, 2222)
  ok('glob Host web* matched')

  const webDb = resolveSshConfig('web-db')
  assert.strictEqual(webDb.port, 2223, 'first-wins: specific block before wildcard')
  ok('specific block wins over wildcard')

  const corp = resolveSshConfig('corphost', 'alice')
  assert.strictEqual(corp.port, 3000)
  ok('Match host+user criteria')

  const explicit = resolveSshConfig('github', undefined, 1234)
  assert.strictEqual(explicit.port, 1234)
  ok('explicit port overrides config')

  const hosts = listSshHosts()
  assert.ok(hosts.includes('github'), 'literal host listed')
  assert.ok(hosts.includes('web-db'), 'literal host listed')
  assert.ok(!hosts.includes('web*'), 'wildcard excluded')
  ok('listSshHosts')

  if (orig !== null) fs.writeFileSync(cfgPath, orig)
  else fs.rmSync(cfgPath, { force: true })
}

function testKnownHosts(): void {
  console.log('known-hosts')
  const blob = makeKeyBlob()
  const type = keyTypeOf(blob)
  assert.strictEqual(type, 'ssh-ed25519')
  const fp = fingerprint(blob)
  assert.ok(fp.startsWith('SHA256:'), `fingerprint prefix: ${fp}`)
  ok('keyTypeOf + fingerprint')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'))
  const file = path.join(dir, 'known_hosts')

  assert.strictEqual(checkKnownHost('example.com', 22, blob, [file]), 'notfound')
  const written = addKnownHost('example.com', 22, blob, [file])
  assert.strictEqual(written, file)
  assert.strictEqual(checkKnownHost('example.com', 22, blob, [file]), 'match')
  assert.strictEqual(checkKnownHost('example.com', 2222, blob, [file]), 'notfound', 'different port not matched')
  assert.strictEqual(checkKnownHost('evil.com', 22, blob, [file]), 'notfound')

  addKnownHost('example.com', 2222, blob, [file])
  assert.strictEqual(checkKnownHost('example.com', 2222, blob, [file]), 'match')
  assert.strictEqual(checkKnownHost('example.com', 22, makeKeyBlob(1), [file]), 'mismatch')
  ok('plain + port-prefixed entries')

  // hashed entry
  const salt = Buffer.from('deadbeef', 'hex')
  const hmac = require('crypto').createHmac('sha1', salt).update('example.com').digest('base64')
  const hashedFile = path.join(dir, 'known_hosts_hashed')
  fs.writeFileSync(hashedFile, `|1|${salt.toString('base64')}|${hmac} ${type} ${blob.toString('base64')}\n`)
  assert.strictEqual(checkKnownHost('example.com', 22, blob, [hashedFile]), 'match')
  assert.strictEqual(checkKnownHost('example.com', 22, makeKeyBlob(1), [hashedFile]), 'mismatch')
  ok('hashed |1|salt|hash entries')

  fs.rmSync(dir, { recursive: true, force: true })
}

function testSessionManager(): Promise<void> {
  console.log('SessionManager (node-pty)')
  return new Promise((resolve, reject) => {
    const events: string[] = []
    const manager = new SessionManager((p) => {
      events.push((p as { type: string }).type)
    })

    const isWin = process.platform === 'win32'
    const shell = isWin ? defaultShell() : 'bash'
    const args = isWin ? [] : ['--noprofile', '--norc']
    const cwd = isWin ? os.tmpdir() : '/tmp'
    const session = manager.createLocal({ kind: 'local', cols: 80, rows: 24, shell, args, cwd })
    assert.ok(session.id, 'session id assigned')
    assert.strictEqual(session.label, path.basename(shell).replace(/\.exe$/i, ''))

    let output = ''
    let exited = false
    const origSink = manager
    ;(manager as unknown as { sink: (p: unknown) => void }).sink = (p) => {
      const ev = p as { type: string; id: string; data?: string; code?: number | null }
      if (ev.type === 'session:output' && ev.id === session.id) {
        output += ev.data ?? ''
        if (output.includes('HELLO_FROM_TEST')) {
          console.log('  ok - local pty produced output')
          manager.destroy(session.id)
          setTimeout(() => {
            manager.destroyAll()
            resolve()
          }, 50)
        }
      }
      if (ev.type === 'session:exit') {
        exited = true
      }
    }
    void origSink

    setTimeout(() => session.write(isWin ? 'echo HELLO_FROM_TEST\r\n' : 'echo HELLO_FROM_TEST\n'), 300)
    setTimeout(() => {
      if (!output.includes('HELLO_FROM_TEST')) {
        reject(new Error(`pty did not echo within 6s, got: ${output.slice(0, 200)}`))
      }
    }, 6000)
    void events
    void exited
  })
}

function testSshFlow(): Promise<void> {
  console.log('SshSession (host-key TOFU + auth prompts + error path)')
  // Remove ~/.ssh/known_hosts so the TOFU prompt is guaranteed this run.
  const kh = path.join(os.homedir(), '.ssh', 'known_hosts')
  const khBackup = fs.existsSync(kh) ? fs.readFileSync(kh) : null
  fs.rmSync(kh, { force: true })

  return new Promise((resolve, reject) => {
    const manager = new SessionManager(() => undefined)
    let output = ''
    let sawHostkeyPrompt = false
    let sawPasswordPrompt = false
    let errored = false
    let finished = false

    const restore = (): void => {
      if (khBackup) fs.writeFileSync(kh, khBackup)
      else fs.rmSync(kh, { force: true })
    }
    const done = (fn: () => void): void => {
      if (finished) return
      finished = true
      restore()
      try {
        fn()
      } catch (err) {
        reject(err)
      }
    }
    ;(manager as unknown as { sink: (p: unknown) => void }).sink = (p) => {
      const ev = p as { type: string; data?: string; text?: string; promptId?: string; status?: string }
      if (ev.type === 'session:output') output += ev.data ?? ''
      if (ev.type === 'session:prompt') {
        const t = ev.text ?? ''
        if (/authenticity|can't be established|continue connecting/i.test(t)) {
          sawHostkeyPrompt = true
          manager.answerPrompt(ev.promptId as string, 'yes')
        } else if (/^Password for/i.test(t)) {
          sawPasswordPrompt = true
          manager.answerPrompt(ev.promptId as string, 'wrong-password')
        } else {
          manager.answerPrompt(ev.promptId as string, '')
        }
      }
      if (ev.type === 'session:status' && ev.status === 'error') errored = true
      if (ev.type === 'session:exit') {
        done(() => {
          assert.ok(sawHostkeyPrompt, 'host key TOFU prompt shown')
          assert.ok(sawPasswordPrompt, 'password prompt shown')
          assert.ok(errored, 'connection errored after failed auth')
          assert.ok(output.includes('Using ssh2 to connect to'), 'connection banner shown')
          console.log('  ok - ssh connect flow (TOFU + auth prompt + error)')
          manager.destroyAll()
          resolve()
        })
      }
    }
    manager.createSsh({ kind: 'ssh', target: 'localhost', cols: 80, rows: 24 })
    setTimeout(() => {
      done(() => {
        if (!errored) {
          reject(new Error(`ssh flow did not complete in 15s; hostkey=${sawHostkeyPrompt} pw=${sawPasswordPrompt} err=${errored}`))
        } else {
          reject(new Error('ssh flow errored but exit event never fired'))
        }
      })
    }, 15000)
  })
}

function testSshCheck(): string {
  const kh = path.join(os.homedir(), '.ssh', 'known_hosts')
  return fs.existsSync(kh) ? fs.readFileSync(kh, 'utf8') : ''
}
function testSshRestore(backup: string): void {
  const kh = path.join(os.homedir(), '.ssh', 'known_hosts')
  if (backup) fs.writeFileSync(kh, backup)
  else fs.rmSync(kh, { force: true })
}

/**
 * Regression: servers that only offer keyboard-interactive auth (OpenSSH maps
 * password auth to it) must actually be attempted. ssh2 silently skips a
 * keyboard-interactive method object that lacks a `prompt` function, so this
 * guards against that and asserts the remote shell stream is delivered.
 */
function testSshKeyboardInteractive(): Promise<void> {
  console.log('SshSession (keyboard-interactive only auth)')
  const khBackup = testSshCheck()
  fs.rmSync(path.join(os.homedir(), '.ssh', 'known_hosts'), { force: true })

  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      if (ctx.method === 'none') {
        ctx.reject(['keyboard-interactive'])
        return
      }
      if (ctx.method === 'keyboard-interactive') {
        ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
          if (answers[0] === 'secret') ctx.accept()
          else ctx.reject()
        })
        return
      }
      ctx.reject(['keyboard-interactive'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty) => acceptPty())
        session.on('shell', (acceptShell) => acceptShell().write('KBD_SHELL_OK\r\n$ '))
      })
    })
  })

  return new Promise((resolve, reject) => {
    let output = ''
    let sawKbdPrompt = false
    let finished = false
    const done = (fn: () => void): void => {
      if (finished) return
      finished = true
      testSshRestore(khBackup)
      server.close()
      try {
        fn()
      } catch (err) {
        reject(err)
      }
    }
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      const manager = new SessionManager(() => undefined)
      ;(manager as unknown as { sink: (p: unknown) => void }).sink = (p) => {
        const ev = p as { type: string; data?: string; text?: string; promptId?: string; status?: string }
        if (ev.type === 'session:output') {
          output += ev.data ?? ''
          if (output.includes('KBD_SHELL_OK')) {
            done(() => {
              assert.ok(sawKbdPrompt, 'keyboard-interactive prompt shown')
              assert.ok(output.includes('KBD_SHELL_OK'), 'remote shell stream delivered')
              console.log('  ok - keyboard-interactive auth + shell')
              manager.destroyAll()
              resolve()
            })
          }
        }
        if (ev.type === 'session:prompt') {
          const t = ev.text ?? ''
          if (/^Password:/.test(t)) {
            sawKbdPrompt = true
            manager.answerPrompt(ev.promptId as string, 'secret')
          } else if (/continue connecting/i.test(t)) {
            manager.answerPrompt(ev.promptId as string, 'yes')
          }
        }
      }
      manager.createSsh({ kind: 'ssh', target: `127.0.0.1:${addr.port}`, user: 'tester', cols: 80, rows: 24 })
    })
    setTimeout(() => {
      done(() => reject(new Error(`keyboard-interactive flow timed out; kbdPrompt=${sawKbdPrompt} output=${JSON.stringify(output.slice(0, 200))}`)))
    }, 10000)
  })
}

app.whenReady().then(async () => {
  try {
    testParseTarget()
    testSshConfig()
    testKnownHosts()
    await testSessionManager()
    await testSshKeyboardInteractive()
    await testSshFlow()
    console.log(`\nALL TESTS PASSED (${passed} assertions)`)
    app.exit(0)
  } catch (err) {
    console.error('\nTEST FAILED:', err)
    app.exit(1)
  }
})
