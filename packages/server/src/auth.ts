/**
 * Who is calling. Every request but `/v1/health` carries
 * `Authorization: Bearer <key>`, and the key decides the tenant: a caller
 * never names a tenant, so it cannot ask for another one's records.
 */
import { createHash, timingSafeEqual } from 'node:crypto'

/** Returns the tenant a bearer token belongs to, or `null`. */
export type Authenticate = (token: string) => string | null | Promise<string | null>

/** Shorter keys can be guessed; generate them with `openssl rand -hex 32`. */
export const MIN_KEY_LENGTH = 32

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest()

/**
 * Authenticate with a fixed set of API keys, each mapped to a tenant. Keys
 * are kept only as SHA-256 digests and compared in constant time, every one
 * of them on every request, so timing says nothing about which key was close.
 */
export function apiKeys(keys: Readonly<Record<string, string>>): Authenticate {
  const entries = Object.entries(keys).map(([key, tenant]) => {
    if (key.length < MIN_KEY_LENGTH) throw new Error(`API keys must be at least ${MIN_KEY_LENGTH} characters.`)
    if (tenant.trim() === '') throw new Error('Every API key needs a tenant.')
    return { hash: digest(key), tenant }
  })
  if (entries.length === 0) throw new Error('Give at least one API key.')
  return (token) => {
    const hash = digest(token)
    let found: string | null = null
    for (const e of entries) if (timingSafeEqual(hash, e.hash)) found = e.tenant
    return found
  }
}
