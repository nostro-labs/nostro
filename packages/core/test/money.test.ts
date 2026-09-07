import { describe, expect, it } from 'vitest'
import {
  AssetMismatchError,
  InvalidAssetError,
  Money,
  NATIVE,
  PrecisionError,
  asset,
  isSameCodeDifferentIssuer,
  issuerOf,
  parseAsset,
} from '../src/money/index.js'

const CIRCLE = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const LOOKALIKE = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW'
const USDC = asset('USDC', CIRCLE)
const FAKE_USDC = asset('USDC', LOOKALIKE)

describe('asset', () => {
  it('canonicalises to CODE:ISSUER and round-trips', () => {
    expect(USDC).toBe(`USDC:${CIRCLE}`)
    expect(parseAsset(USDC)).toBe(USDC)
    expect(parseAsset('native')).toBe(NATIVE)
  })

  it('rejects malformed codes and issuers', () => {
    expect(() => asset('', CIRCLE)).toThrow(InvalidAssetError)
    expect(() => asset('TOOLONGASSETCODE', CIRCLE)).toThrow(InvalidAssetError)
    expect(() => asset('USDC', 'not-an-issuer')).toThrow(InvalidAssetError)
    expect(() => parseAsset('USDC')).toThrow(InvalidAssetError)
  })

  it('never treats a lookalike issuer as the same asset', () => {
    expect(USDC).not.toBe(FAKE_USDC)
    expect(isSameCodeDifferentIssuer(USDC, FAKE_USDC)).toBe(true)
    expect(isSameCodeDifferentIssuer(USDC, USDC)).toBe(false)
    expect(isSameCodeDifferentIssuer(USDC, NATIVE)).toBe(false)
  })

  it('exposes the issuer only for non-native assets', () => {
    expect(issuerOf(USDC)).toBe(CIRCLE)
    expect(issuerOf(NATIVE)).toBeNull()
  })
})

describe('Money.parse', () => {
  it('parses Horizon 7-decimal strings exactly', () => {
    expect(Money.parse('12.5000000', NATIVE).raw).toBe(125_000_000n)
    expect(Money.parse('0.0000001', NATIVE).raw).toBe(1n)
    expect(Money.parse('1', NATIVE).raw).toBe(10_000_000n)
    expect(Money.parse('-3.25', NATIVE).raw).toBe(-32_500_000n)
  })

  it('round-trips through toString with fixed precision', () => {
    for (const v of ['12.5000000', '0.0000001', '-3.2500000', '0.0000000']) {
      expect(Money.parse(v, NATIVE).toString()).toBe(v)
    }
    expect(Money.parse('1', NATIVE).toString()).toBe('1.0000000')
  })

  it('holds values beyond IEEE-754 integer range without loss', () => {
    // 1e12 XLM in stroops is 1e19 — past Number.MAX_SAFE_INTEGER (~9.0e15).
    const big = Money.parse('1000000000000', NATIVE)
    expect(big.raw).toBe(10_000_000_000_000_000_000n)
    expect(big.raw > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(big.toString()).toBe('1000000000000.0000000')
  })

  it('refuses to round a value it cannot represent', () => {
    expect(() => Money.parse('0.00000001', NATIVE)).toThrow(PrecisionError)
  })

  it('rejects number input rather than silently losing precision', () => {
    // @ts-expect-error -- guarding the runtime, not just the types
    expect(() => Money.parse(0.1 + 0.2, NATIVE)).toThrow(PrecisionError)
    // @ts-expect-error -- same guard on the raw constructor
    expect(() => Money.fromRaw(125_000_000, NATIVE)).toThrow(PrecisionError)
  })

  it('rejects malformed amounts', () => {
    for (const v of ['', 'abc', '1.2.3', '1e7', '--1']) {
      expect(() => Money.parse(v, NATIVE)).toThrow(PrecisionError)
    }
  })

  it('supports non-classic decimals for contract tokens', () => {
    const tok = asset('TOK', CIRCLE)
    expect(Money.parse('1.23', tok, 2).raw).toBe(123n)
    expect(Money.parse('1.23', tok, 2).toString()).toBe('1.23')
    expect(Money.fromRaw(5n, tok, 0).toString()).toBe('5')
    expect(() => Money.parse('1', tok, 39)).toThrow(PrecisionError)
  })
})

describe('Money arithmetic', () => {
  it('adds and subtracts exactly', () => {
    const a = Money.parse('0.1', NATIVE)
    const b = Money.parse('0.2', NATIVE)
    // The float trap: 0.1 + 0.2 !== 0.3 in IEEE-754, but is exact here.
    expect(a.add(b).toString()).toBe('0.3000000')
    expect(b.subtract(a).toString()).toBe('0.1000000')
    expect(a.subtract(b).toString()).toBe('-0.1000000')
  })

  it('refuses cross-asset arithmetic, and explains lookalike issuers', () => {
    const real = Money.parse('1', USDC)
    const fake = Money.parse('1', FAKE_USDC)
    expect(() => real.add(fake)).toThrow(AssetMismatchError)
    expect(() => real.add(fake)).toThrow(/share a code but have different issuers/)
    expect(() => real.compare(fake)).toThrow(AssetMismatchError)
    expect(real.equals(fake)).toBe(false)
  })

  it('refuses to mix differing decimals for the same asset', () => {
    expect(() => Money.fromRaw(1n, USDC, 7).add(Money.fromRaw(1n, USDC, 2))).toThrow(PrecisionError)
  })

  it('compares, negates and reports sign', () => {
    const one = Money.parse('1', NATIVE)
    const two = Money.parse('2', NATIVE)
    expect(one.compare(two)).toBe(-1)
    expect(two.compare(one)).toBe(1)
    expect(one.compare(one)).toBe(0)
    expect(one.negate().isNegative()).toBe(true)
    expect(one.negate().abs().equals(one)).toBe(true)
    expect(Money.zero(NATIVE).isZero()).toBe(true)
    expect(one.isPositive()).toBe(true)
  })

  it('serialises without precision loss', () => {
    expect(Money.parse('12.5', NATIVE).toJSON()).toEqual({
      raw: '125000000',
      asset: NATIVE,
      decimals: 7,
    })
  })
})
