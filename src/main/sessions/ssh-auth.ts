import * as fs from 'fs'
import { utils } from 'ssh2'
import type { ConnectConfig } from 'ssh2'

/**
 * Interactive authentication flow for ssh2, mirroring wezterm's auth.rs order:
 * agent -> publickey (each IdentityFile, with passphrase prompting) -> password
 * -> keyboard-interactive. Prompt strings mirror wezterm's.
 */

export interface AuthDeps {
  host: string
  port: number
  user: string
  identityFiles: string[]
  identitiesOnly: boolean
  agent?: string
  /** Password supplied up-front in the SSH dialog (skips the prompt). */
  password?: string
  /** Inline prompt (LineEditor equivalent). Empty answer = user cancelled. */
  ask: (text: string, echo: boolean) => Promise<string>
  /**
   * Bridge for keyboard-interactive auth: ssh2 requires the auth method object
   * to carry a `prompt` function. We forward it to the Client's
   * 'keyboard-interactive' event, which SshSession handles.
   */
  interactive: (
    name: string,
    instructions: string,
    lang: string,
    prompts: Array<{ prompt: string; echo?: boolean }>,
    finish: (answers: string[]) => void
  ) => void
  log: (msg: string) => void
}

type AuthHandler = NonNullable<ConnectConfig['authHandler']>

/** A step produces a method object ssh2 understands (or false to skip). */
type Step = () => Promise<Record<string, unknown> | string | false>

export function createAuthHandler(deps: AuthDeps): AuthHandler {
  const { user, host } = deps

  let passwordAttempted = false
  let kbdRequested = false
  let triedAgent = false
  const triedKeys = new Set<string>()

  function parseKey(data: Buffer, passphrase?: string): ReturnType<typeof utils.parseKey> {
    try {
      return utils.parseKey(data, passphrase)
    } catch (err) {
      return new Error(String(err))
    }
  }

  function isParseError(v: unknown): v is Error {
    return v instanceof Error && 'message' in v
  }

  async function publicKeyStep(file: string): Promise<Record<string, unknown> | false> {
    if (triedKeys.has(file)) return false
    triedKeys.add(file)
    let content: Buffer
    try {
      content = fs.readFileSync(file)
    } catch {
      deps.log(`Skipping missing identity file ${file}`)
      return false
    }
    let parsed = parseKey(content)
    if (isParseError(parsed)) {
      const msg = (parsed as Error).message
      if (/passphrase|encrypted/i.test(msg)) {
        const pass = await deps.ask(`Passphrase to decrypt ${file} for ${user}@${host}: `, false)
        if (!pass) return false
        parsed = parseKey(content, pass)
        if (isParseError(parsed)) {
          deps.log(`Failed to decrypt key ${file}: ${(parsed as Error).message}`)
          return false
        }
      } else {
        deps.log(`Unusable identity file ${file}: ${msg}`)
        return false
      }
    }
    const key = Array.isArray(parsed) ? parsed[0] : (parsed as ReturnType<typeof utils.parseKey>)
    return { type: 'publickey', username: user, key }
  }

  async function passwordStep(): Promise<Record<string, unknown> | false> {
    if (passwordAttempted) return false
    passwordAttempted = true
    const answer = deps.password ?? (await deps.ask(`Password for ${user}@${host}: `, false))
    if (!answer) return false
    return { type: 'password', username: user, password: answer }
  }

  async function agentStep(): Promise<Record<string, unknown> | false> {
    if (triedAgent) return false
    triedAgent = true
    return { type: 'agent', username: user, agent: deps.agent }
  }

  async function kbdStep(): Promise<Record<string, unknown> | false> {
    if (kbdRequested) return false
    kbdRequested = true
    return {
      type: 'keyboard-interactive',
      username: user,
      prompt: (
        name: string,
        instructions: string,
        lang: string,
        prompts: Array<{ prompt: string; echo?: boolean }>,
        finish: (answers: string[]) => void
      ): void => deps.interactive(name, instructions, lang, prompts, finish)
    }
  }

  const plan: Step[] = []
  let planIndex = 0

  return (methodsLeft, _partial, callback) => {
    if (methodsLeft === null) {
      callback('none')
      return
    }
    const methods: string[] = methodsLeft ?? []

    // Build the plan lazily on the first real auth attempt.
    if (plan.length === 0) {
      const canPubkey = methods.includes('publickey')
      const canPassword = methods.includes('password')
      const canKbd = methods.includes('keyboard-interactive')
      if (canPubkey && !deps.identitiesOnly && deps.agent) plan.push(agentStep)
      if (canPubkey) {
        for (const f of deps.identityFiles) plan.push(() => publicKeyStep(f))
      }
      if (canPassword) plan.push(passwordStep)
      if (canKbd) plan.push(kbdStep)
    }

    const run = async (): Promise<void> => {
      while (planIndex < plan.length) {
        const step = plan[planIndex++]
        let result: Record<string, unknown> | string | false
        try {
          result = await step()
        } catch (err) {
          deps.log(`auth error: ${String(err)}`)
          result = false
        }
        if (result !== false) {
          callback(result as Parameters<typeof callback>[0])
          return
        }
      }
      callback(false as unknown as Parameters<typeof callback>[0])
    }
    void run()
  }
}
