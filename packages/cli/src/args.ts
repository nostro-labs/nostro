/**
 * Options, and where their values come from: a flag, else an environment
 * variable, else a default. Parsing is strict: an option a command does not
 * know is a usage error, not something to ignore.
 */
import { parseArgs } from 'node:util'
import type { ParseArgsConfig } from 'node:util'
import { isAccountId } from 'nostro'
import type { Io } from './io.js'

/** The command line was wrong. Exit status 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** The command could not do what was asked, for a reason the message explains. Exit status 1. */
export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

export type OptionSpec = NonNullable<ParseArgsConfig['options']>
type Value = string | boolean | (string | boolean)[] | undefined

export interface Args {
  readonly values: Readonly<Record<string, Value>>
  readonly positionals: readonly string[]
}

/** Every command takes these. */
export const COMMON: OptionSpec = {
  db: { type: 'string' },
  tenant: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

/** Commands that talk to Horizon take these. */
export const NETWORK: OptionSpec = {
  network: { type: 'string' },
  horizon: { type: 'string' },
  account: { type: 'string', multiple: true },
}

export function parse(argv: readonly string[], options: OptionSpec): Args {
  try {
    const { values, positionals } = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true })
    return { values: values as Record<string, Value>, positionals }
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err))
  }
}

export function string(args: Args, name: string): string | undefined {
  const v = args.values[name]
  return typeof v === 'string' ? v : undefined
}

export function flag(args: Args, name: string): boolean {
  return args.values[name] === true
}

export function strings(args: Args, name: string): string[] {
  const v = args.values[name]
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
}

/** At most `max` positionals; returns them. */
export function positionals(args: Args, max: number): readonly string[] {
  if (args.positionals.length > max) {
    throw new UsageError(`Unexpected argument ${JSON.stringify(args.positionals[max])}.`)
  }
  return args.positionals
}

/** A whole number in range, from an option. */
export function integer(args: Args, name: string, fallback: number, min = 1, max = 1_000_000): number {
  const raw = string(args, name)
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max}.`)
  }
  return Number(raw)
}

export const DEFAULT_DB = 'nostro.db'

export const database = (args: Args, io: Io): string => string(args, 'db') ?? io.env.NOSTRO_DB ?? DEFAULT_DB

export function tenant(args: Args, io: Io): string {
  const id = string(args, 'tenant') ?? io.env.NOSTRO_TENANT ?? 'default'
  if (id.trim() === '') throw new UsageError('--tenant must not be empty.')
  return id
}

const HORIZON: Readonly<Record<string, string>> = {
  testnet: 'https://horizon-testnet.stellar.org',
  public: 'https://horizon.stellar.org',
}

export interface Network {
  /** The label recorded on every movement, e.g. `testnet`. */
  readonly name: string
  readonly horizon: string
}

export function network(args: Args, io: Io): Network {
  const name = string(args, 'network') ?? io.env.NOSTRO_NETWORK ?? 'testnet'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new UsageError(`--network must be a lowercase label such as testnet or public, not ${JSON.stringify(name)}.`)
  }
  const horizon = string(args, 'horizon') ?? io.env.NOSTRO_HORIZON_URL ?? HORIZON[name]
  if (horizon === undefined) {
    throw new UsageError(`Network ${name} has no default Horizon; pass --horizon <url>.`)
  }
  let url: URL
  try {
    url = new URL(horizon)
  } catch {
    throw new UsageError(`--horizon must be a URL, not ${JSON.stringify(horizon)}.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError(`--horizon must be an http(s) URL, not ${JSON.stringify(horizon)}.`)
  }
  return { name, horizon }
}

/** The accounts to work on: every `--account`, else `NOSTRO_ACCOUNTS` (comma or space separated). */
export function accounts(args: Args, io: Io): string[] {
  const given = strings(args, 'account')
  const list = given.length > 0 ? given : (io.env.NOSTRO_ACCOUNTS ?? '').split(/[\s,]+/).filter((a) => a !== '')
  if (list.length === 0) {
    throw new UsageError('Name at least one account: --account G... (or set NOSTRO_ACCOUNTS).')
  }
  for (const a of list) {
    if (!isAccountId(a)) throw new UsageError(`${JSON.stringify(a)} is not a G... account id.`)
  }
  return [...new Set(list)]
}
