/**
 * Asset identity.
 *
 * Stellar assets are identified by a code *and* an issuer. Two assets sharing a
 * code but not an issuer are entirely different assets — a lookalike `USDC`
 * from an arbitrary issuer is not Circle's USDC. Comparing on code alone is a
 * security bug, so this module only ever exposes the canonical form
 * `CODE:ISSUER` (or the sentinel `native` for XLM) and there is deliberately no
 * accessor that returns a bare code for comparison.
 */

/** Canonical asset identifier: `native`, or `CODE:ISSUER`. */
export type AssetId = string & { readonly __brand: 'AssetId' }

/** The native asset (XLM). */
export const NATIVE: AssetId = 'native' as AssetId

/** Stellar asset codes are 1-12 alphanumeric characters. */
const CODE_RE = /^[A-Za-z0-9]{1,12}$/
/** Ed25519 public keys (`G...`) are 56 base32 characters. */
const ISSUER_RE = /^G[A-Z2-7]{55}$/

export class InvalidAssetError extends Error {
  public readonly code = 'INVALID_ASSET'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAssetError'
  }
}

/** Build a canonical `AssetId` from a code and issuer. */
export function asset(code: string, issuer: string): AssetId {
  if (!CODE_RE.test(code)) {
    throw new InvalidAssetError(
      `Invalid asset code ${JSON.stringify(code)}: expected 1-12 alphanumeric characters.`,
    )
  }
  if (!ISSUER_RE.test(issuer)) {
    throw new InvalidAssetError(
      `Invalid asset issuer ${JSON.stringify(issuer)}: expected a 56-character G... address.`,
    )
  }
  return `${code}:${issuer}` as AssetId
}

/** Parse a canonical asset id, round-tripping `asset()` and `NATIVE`. */
export function parseAsset(id: string): AssetId {
  if (id === NATIVE) return NATIVE
  const idx = id.indexOf(':')
  if (idx === -1) {
    throw new InvalidAssetError(
      `Invalid asset id ${JSON.stringify(id)}: expected "native" or "CODE:ISSUER".`,
    )
  }
  return asset(id.slice(0, idx), id.slice(idx + 1))
}

export function isNative(id: AssetId): boolean {
  return id === NATIVE
}

/** The issuer of a non-native asset, or `null` for the native asset. */
export function issuerOf(id: AssetId): string | null {
  if (id === NATIVE) return null
  return id.slice(id.indexOf(':') + 1)
}

/**
 * True when two assets share a code but have different issuers.
 *
 * This is the lookalike-asset case. It exists so callers can raise a
 * `WRONG_ASSET` exception that explains *why* two same-looking assets did not
 * match, rather than reporting a bare inequality.
 */
export function isSameCodeDifferentIssuer(a: AssetId, b: AssetId): boolean {
  if (a === b) return false
  if (a === NATIVE || b === NATIVE) return false
  return a.slice(0, a.indexOf(':')) === b.slice(0, b.indexOf(':'))
}
