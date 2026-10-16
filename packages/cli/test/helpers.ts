import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { main } from '../src/index.js'

export const A = `G${'A'.repeat(55)}`
export const B = `G${'B'.repeat(55)}`

const root = mkdtempSync(join(tmpdir(), 'nostro-cli-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let dirs = 0
/** A fresh, empty working directory. */
export function workspace(): string {
  const dir = join(root, `w${++dirs}`)
  mkdirSync(dir)
  return dir
}

export interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly fetch?: typeof globalThis.fetch
  /** Pretend stderr is a terminal. */
  readonly tty?: boolean
}

/** Run `nostro <argv>` in-process, in `cwd`. */
export async function nostro(cwd: string, argv: readonly string[], options: RunOptions = {}): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const code = await main(argv, {
    stdout: {
      write: (s) => {
        stdout += s
        return true
      },
    },
    stderr: {
      write: (s) => {
        stderr += s
        return true
      },
      ...(options.tty === undefined ? {} : { isTTY: options.tty }),
    },
    env: options.env ?? {},
    cwd,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  return { code, stdout, stderr }
}

/** A working directory with a migrated `nostro.db`. */
export async function migrated(): Promise<string> {
  const cwd = workspace()
  const { code, stderr } = await nostro(cwd, ['migrate'])
  if (code !== 0) throw new Error(stderr)
  return cwd
}
