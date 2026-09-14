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
import { listSavedHosts, saveSshHost, deleteSshHost, loadConfig, updateConfig } from '../src/main/config'
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

function testSavedSshHosts(): void {
  console.log('saved ssh hosts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmux-cfg-'))
  const original = app.getPath('userData')
  app.setPath('userData', dir)
  try {
    assert.deepStrictEqual(listSavedHosts(), [], 'starts empty')

    let list = saveSshHost({ id: 'a1', name: 'web', host: 'example.com', user: 'root', port: 2222 })
    assert.strictEqual(list.length, 1)
    assert.strictEqual(list[0].name, 'web')
    assert.strictEqual(list[0].port, 2222)
    ok('saveSshHost adds a profile')

    // Same host/user/port updates the existing entry in place (keeps its id).
    list = saveSshHost({ id: 'ignored', name: 'web2', host: 'example.com', user: 'root', port: 2222 })
    assert.strictEqual(list.length, 1, 'duplicate target does not append')
    assert.strictEqual(list[0].id, 'a1', 'existing id preserved')
    assert.strictEqual(list[0].name, 'web2', 'name updated')
    ok('saveSshHost updates duplicate target')

    list = saveSshHost({ id: 'b1', name: 'db', host: 'db.internal', user: 'db' })
    assert.strictEqual(list.length, 2)
    assert.deepStrictEqual(listSavedHosts().map((h) => h.host).sort(), ['db.internal', 'example.com'])
    ok('listSavedHosts reads persisted profiles')

    list = deleteSshHost('a1')
    assert.strictEqual(list.length, 1)
    assert.strictEqual(list[0].host, 'db.internal')
    ok('deleteSshHost removes a profile')
  } finally {
    app.setPath('userData', original)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * updateConfig deep-merges a partial patch (e.g. the font settings dialog) into
 * the stored config, persists it, and keeps unspecified defaults intact.
 */
function testUpdateConfig(): void {
  console.log('config: updateConfig (deep merge)')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmux-cfg2-'))
  const original = app.getPath('userData')
  app.setPath('userData', dir)
  try {
    const c1 = updateConfig({ font: { size: 18 } })
    assert.strictEqual(c1.font.size, 18)
    assert.strictEqual(c1.font.family, 'Maple Mono NF CN', 'default font family preserved')
    assert.strictEqual(c1.font.lineHeight, 1.15, 'unspecified field keeps default')
    assert.strictEqual(c1.scrollback, 10000, 'default history limit is 10000')
    assert.strictEqual(loadConfig().font.size, 18, 'persisted to disk')
    ok('updateConfig merges + persists')

    const c2 = updateConfig({ font: { family: 'JetBrains Mono', size: 12, lineHeight: 1.3 } })
    assert.strictEqual(c2.font.family, 'JetBrains Mono')
    assert.strictEqual(c2.font.size, 12)
    assert.strictEqual(c2.font.lineHeight, 1.3)
    assert.strictEqual(loadConfig().font.family, 'JetBrains Mono')
    ok('updateConfig replaces font fields')

    const c3 = updateConfig({ scrollback: 50000 })
    assert.strictEqual(c3.scrollback, 50000)
    assert.strictEqual(c3.font.family, 'JetBrains Mono', 'prior font setting preserved')
    assert.strictEqual(loadConfig().scrollback, 50000)
    ok('updateConfig sets history limit')
  } finally {
    app.setPath('userData', original)
    fs.rmSync(dir, { recursive: true, force: true })
  }
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

/**
 * Terminal-aware tools read the pty env to decide what they may draw. yazi in
 * particular maps TERM_PROGRAM to an image protocol and falls back to chafa
 * (no real image) for anything it does not recognise, so the renderer's
 * @xterm/addon-image support only pays off while this stays 'vscode'.
 */
function testSessionEnv(): Promise<void> {
  console.log('LocalSession (pty env)')
  return new Promise((resolve, reject) => {
    const manager = new SessionManager(() => undefined)
    // Echo through the platform shell rather than spawning a node child: this
    // harness itself runs under Electron, so process.execPath is electron.exe.
    // One line, well under the 80-col wrap that would split the values apart.
    const isWin = process.platform === 'win32'
    const session = manager.createLocal({
      kind: 'local',
      cols: 80,
      rows: 24,
      shell: isWin ? defaultShell() : 'sh',
      args: isWin
        ? ['/c', 'echo ENVPROBE:%TERM%,%TERM_PROGRAM%,%COLORTERM%']
        : ['-c', 'echo ENVPROBE:$TERM,$TERM_PROGRAM,$COLORTERM'],
      cwd: isWin ? os.tmpdir() : '/tmp'
    })

    let output = ''
    ;(manager as unknown as { sink: (p: unknown) => void }).sink = (p) => {
      const ev = p as { type: string; id: string; data?: string }
      if (ev.type !== 'session:output' || ev.id !== session.id) return
      output += ev.data ?? ''
      const line = output.match(/ENVPROBE:([^\r\n]*)/)?.[1]
      if (!line) return
      manager.destroyAll()
      try {
        // ConPTY tacks an erase-to-end-of-line onto the line, so drop escapes.
        const plain = line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim()
        // term, TERM_PROGRAM, COLORTERM -- in that order.
        assert.deepStrictEqual(plain.split(','), ['xterm-256color', 'vscode', 'truecolor'])
      } catch (err) {
        reject(err)
        return
      }
      ok('pty env carries TERM / TERM_PROGRAM / COLORTERM')
      resolve()
    }
    setTimeout(() => reject(new Error(`env probe timed out, got: ${output.slice(0, 300)}`)), 10000)
  })
}

/** Probe a TCP port so tests that need the machine's own sshd can skip cleanly. */
function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = require('net').connect({ host, port })
    const finish = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
    socket.setTimeout(1000, () => finish(false))
  })
}

async function testSshFlow(): Promise<void> {
  console.log('SshSession (host-key TOFU + auth prompts + error path)')
  if (!(await portOpen('127.0.0.1', 22))) {
    console.log('  skip - no local sshd on 127.0.0.1:22')
    return
  }
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

/**
 * wezterm parity: a second pane/tab on the same SSH target reuses the
 * authenticated transport (RemoteSshDomain keeps one Session) instead of
 * dialing again, so host-key and password prompts appear only once.
 */
function testSshConnectionReuse(): Promise<void> {
  console.log('SessionManager (SSH connection reuse)')
  const khBackup = testSshCheck()
  fs.rmSync(path.join(os.homedir(), '.ssh', 'known_hosts'), { force: true })

  let shells = 0
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === 'secret') ctx.accept()
      else ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty) => acceptPty())
        session.on('shell', (acceptShell) => {
          const n = ++shells
          acceptShell().write(`REUSE_SHELL_${n}\r\n$ `)
        })
      })
    })
  })

  return new Promise((resolve, reject) => {
    let output = ''
    let passwordPrompts = 0
    let hostkeyPrompts = 0
    let secondStarted = false
    let finished = false
    let firstSessionId = ''
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
        const ev = p as { type: string; id?: string; data?: string; text?: string; promptId?: string; status?: string }
        if (ev.type === 'session:output') {
          output += ev.data ?? ''
          // Once pane 1 has its shell, open a second pane on the same target.
          if (!secondStarted && ev.id === firstSessionId && output.includes('REUSE_SHELL_1')) {
            secondStarted = true
            manager.createSsh({ kind: 'ssh', target: `127.0.0.1:${addr.port}`, user: 'tester', cols: 80, rows: 24 })
          }
          if (secondStarted && output.includes('REUSE_SHELL_2')) {
            done(() => {
              assert.strictEqual(passwordPrompts, 1, 'password prompted once for the shared transport')
              assert.strictEqual(hostkeyPrompts, 1, 'host key prompted once for the shared transport')
              assert.strictEqual(shells, 2, 'both panes got a shell channel')
              console.log('  ok - second SSH pane reuses the connection (no re-auth)')
              manager.destroyAll()
              resolve()
            })
          }
        }
        if (ev.type === 'session:status' && ev.status === 'error') {
          done(() => reject(new Error(`reuse flow errored: ${output.slice(0, 300)}`)))
        }
        if (ev.type === 'session:prompt') {
          const t = ev.text ?? ''
          if (/^Password for/i.test(t)) {
            passwordPrompts++
            manager.answerPrompt(ev.promptId as string, 'secret')
          } else if (/continue connecting/i.test(t)) {
            hostkeyPrompts++
            manager.answerPrompt(ev.promptId as string, 'yes')
          }
        }
      }
      const first = manager.createSsh({ kind: 'ssh', target: `127.0.0.1:${addr.port}`, user: 'tester', cols: 80, rows: 24 })
      firstSessionId = first.id
    })
    setTimeout(() => {
      done(() =>
        reject(
          new Error(
            `reuse flow timed out; pw=${passwordPrompts} hostkey=${hostkeyPrompts} shells=${shells} output=${JSON.stringify(output.slice(0, 200))}`
          )
        )
      )
    }, 10000)
  })
}

/**
 * Regression: the pty must be created at the size the pane has *when the channel
 * opens*, not the size the session was asked for at create time.
 *
 * Authentication can take seconds (TOFU, password, keyboard-interactive) and the
 * terminal of a pane split off an existing one is fitted -- and re-fitted --
 * while that wait is in flight. The pty request used to carry the size captured
 * before the wait, so a full-screen program starting in that pane (Claude Code,
 * vim) drew for a terminal the pane no longer was, which is the kind of
 * misalignment that a redraw appears to "fix".
 *
 * Two windows are covered, because they need different handling:
 *   - a resize during authentication changes what the pty request itself carries;
 *   - a resize between the request and the server answering it has no stream to
 *     go to yet, so it has to be forwarded as a window-change afterwards.
 */
function testSshPtySizeRace(): Promise<void> {
  console.log('SshSession (pty size follows the terminal, not the create-time size)')
  const khBackup = testSshCheck()
  fs.rmSync(path.join(os.homedir(), '.ssh', 'known_hosts'), { force: true })

  let ptyInfo: { cols: number; rows: number } | null = null
  const windowChanges: Array<{ cols: number; rows: number }> = []
  // Hold the pty reply open long enough for the in-flight resize to land.
  const ptyReplyDelay = 300

  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === 'secret') ctx.accept()
      else ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty, _rejectPty, info) => {
          ptyInfo = { cols: info.cols, rows: info.rows }
          setTimeout(() => acceptPty(), ptyReplyDelay)
        })
        session.on('window-change', (acceptChange, _reject, info) => {
          windowChanges.push({ cols: info.cols, rows: info.rows })
          acceptChange()
        })
        session.on('shell', (acceptShell) => {
          acceptShell().write('SIZE_PROBE_READY\r\n$ ')
        })
      })
    })
  })

  return new Promise((resolve, reject) => {
    let finished = false
    let sessionId = ''
    let poll: ReturnType<typeof setInterval> | undefined
    const done = (fn: () => void): void => {
      if (finished) return
      finished = true
      if (poll !== undefined) clearInterval(poll)
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
        const ev = p as { type: string; data?: string; text?: string; promptId?: string }
        if (ev.type === 'session:prompt') {
          const t = ev.text ?? ''
          if (/^Password for/i.test(t)) {
            // Still authenticating: the pane has been fitted since create, and
            // the pty does not exist yet.
            manager.resize(sessionId, 132, 43)
            manager.answerPrompt(ev.promptId as string, 'secret')
          } else if (/continue connecting/i.test(t)) {
            manager.answerPrompt(ev.promptId as string, 'yes')
          } else {
            manager.answerPrompt(ev.promptId as string, '')
          }
        }
      }

      sessionId = manager.createSsh({ kind: 'ssh', target: `127.0.0.1:${addr.port}`, user: 'tester', cols: 80, rows: 24 }).id

      // Phase two: wait until the pty request has been sent (the server has seen
      // it) but while its reply is still being held. There is no channel to send
      // a resize through at that point, so this only reaches the pty if the
      // session forwards it once the channel is up.
      poll = setInterval(() => {
        if (!ptyInfo || !sessionId || finished) return
        if (poll !== undefined) clearInterval(poll)
        manager.resize(sessionId, 100, 30)
      }, 10)

      const settle = setInterval(() => {
        if (finished) return
        if (ptyInfo && windowChanges.some((c) => c.cols === 100 && c.rows === 30)) {
          clearInterval(settle)
          done(() => {
            assert.deepStrictEqual(ptyInfo, { cols: 132, rows: 43 }, 'pty created at the size the pane had when the channel opened')
            assert.ok(
              windowChanges.some((c) => c.cols === 100 && c.rows === 30),
              `resize racing the pty reply forwarded as window-change: ${JSON.stringify(windowChanges)}`
            )
            console.log('  ok - pty size follows the pane across auth and channel open')
            manager.destroyAll()
            resolve()
          })
        }
      }, 25)
    })
    setTimeout(() => {
      done(() =>
        reject(
          new Error(
            `pty size flow timed out; pty=${JSON.stringify(ptyInfo)} windowChanges=${JSON.stringify(windowChanges)}`
          )
        )
      )
    }, 10000)
  })
}

/**
 * cwd inheritance: a pane spawned on an inherited SSH connection lands in the
 * directory its spawning pane was in. The landing `cd` rides in an exec wrapper
 * so it never shows up as a typed command or a history entry; a server that
 * refuses the exec request must still get the directory, typed in instead.
 *
 * The directory itself is whatever the far side reported as OSC 7 (see the
 * README for the shell integration that has to be in place there); here it is
 * handed straight to `createSsh`.
 */
function testSshCwd(allowExec: boolean): Promise<void> {
  console.log(`SshSession (cwd inheritance: ${allowExec ? 'exec wrapper' : 'exec refused -> shell fallback'})`)
  const khBackup = testSshCheck()
  fs.rmSync(path.join(os.homedir(), '.ssh', 'known_hosts'), { force: true })

  // A cwd with a quote in it, so the shell quoting is exercised too.
  const CWD = "/srv/it's app"
  const QUOTED = `'/srv/it'\\''s app'`
  let execCommand: string | null = null
  let typed = ''

  const record = (stream: { on: (ev: string, cb: (d: Buffer) => void) => void }): void => {
    stream.on('data', (d: Buffer) => {
      typed += d.toString('utf8')
    })
  }
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === 'secret') ctx.accept()
      else ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty) => acceptPty())
        session.on('exec', (acceptExec, rejectExec, info) => {
          if (!allowExec) {
            rejectExec()
            return
          }
          execCommand = info.command
          const stream = acceptExec()
          record(stream)
          stream.write('CWD_READY\r\n$ ')
        })
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          record(stream)
          stream.write('CWD_READY\r\n$ ')
        })
      })
    })
  })

  return new Promise((resolve, reject) => {
    let output = ''
    let finished = false
    let manager: SessionManager | null = null
    let setupWatch: ReturnType<typeof setInterval> | undefined
    const done = (fn: () => void): void => {
      if (finished) return
      finished = true
      if (setupWatch !== undefined) clearInterval(setupWatch)
      testSshRestore(khBackup)
      server.close()
      try {
        fn()
      } catch (err) {
        reject(err)
      }
    }
    /**
     * The wrapper path types nothing at all, so it only needs the channel to be
     * up (plus a settle window, since `typed` staying empty is a negative). The
     * fallback path is done once its `cd` has arrived.
     */
    const awaitLanding = (): void => {
      if (setupWatch !== undefined) return
      const since = Date.now()
      setupWatch = setInterval(() => {
        if (!allowExec && !typed.includes('cd -- ')) return
        if (Date.now() - since < 250) return
        done(() => {
          if (allowExec) {
            assert.ok(execCommand, 'exec request carried the wrapper')
            assert.ok(
              (execCommand as string).includes(`cd -- ${QUOTED} 2>/dev/null`),
              `cwd quoted into the wrapper: ${execCommand}`
            )
            assert.ok(
              (execCommand as string).includes('exec "${SHELL:-/bin/sh}" -l'),
              'wrapper hands over to a login shell'
            )
            assert.strictEqual(typed, '', 'the wrapper path types nothing into the session')
          } else {
            assert.strictEqual(execCommand, null, 'no exec request when the server refuses one')
            assert.ok(typed.includes(`cd -- ${QUOTED} 2>/dev/null`), `cwd typed instead: ${typed}`)
          }
          console.log(`  ok - ${allowExec ? 'exec wrapper' : 'shell fallback'} lands the pane in the inherited cwd`)
          manager?.destroyAll()
          resolve()
        })
      }, 50)
    }
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      const live = new SessionManager(() => undefined)
      manager = live
      ;(live as unknown as { sink: (p: unknown) => void }).sink = (p) => {
        const ev = p as { type: string; data?: string; text?: string; promptId?: string; status?: string }
        if (ev.type === 'session:output') {
          output += ev.data ?? ''
          if (output.includes('CWD_READY')) awaitLanding()
        }
        if (ev.type === 'session:prompt') {
          const t = ev.text ?? ''
          if (/continue connecting/i.test(t)) live.answerPrompt(ev.promptId as string, 'yes')
          else if (/^Password for/i.test(t)) live.answerPrompt(ev.promptId as string, 'secret')
          else live.answerPrompt(ev.promptId as string, '')
        }
        if (ev.type === 'session:status' && ev.status === 'error') {
          done(() => reject(new Error(`cwd flow errored: ${output.slice(0, 300)}`)))
        }
      }
      live.createSsh({
        kind: 'ssh',
        target: `127.0.0.1:${addr.port}`,
        user: 'tester',
        cols: 80,
        rows: 24,
        cwd: CWD
      })
    })
    setTimeout(() => {
      done(() =>
        reject(
          new Error(
            `cwd flow timed out; exec=${execCommand === null ? 'none' : 'yes'} typed=${JSON.stringify(typed.slice(0, 200))}`
          )
        )
      )
    }, 10000)
  })
}

app.whenReady().then(async () => {
  try {
    testParseTarget()
    testSshConfig()
    testSavedSshHosts()
    testUpdateConfig()
    testKnownHosts()
    await testSessionManager()
    await testSessionEnv()
    await testSshKeyboardInteractive()
    await testSshConnectionReuse()
    await testSshPtySizeRace()
    await testSshCwd(true)
    await testSshCwd(false)
    await testSshFlow()
    console.log(`\nALL TESTS PASSED (${passed} assertions)`)
    app.exit(0)
  } catch (err) {
    console.error('\nTEST FAILED:', err)
    app.exit(1)
  }
})
