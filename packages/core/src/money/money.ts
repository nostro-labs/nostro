/**
 * Exact monetary amounts.
 *
 * Every amount is an integer count of the asset's smallest unit (`raw`) plus
 * the number of decimal places that unit represents. Classic Stellar assets use
 * 7 decimals, so 1 XLM is 10_000_000 raw units ("stroops"); SEP-41 contract
 * tokens may declare any number.
 *
 * Amounts are never represented as `number`. Horizon returns amounts as decimal
 * strings such as `"12.5000000"`, and IEEE-754 cannot hold every stroop value
 * above 2^53 (~900M XLM) nor represent most 7-decimal fractions exactly. Every
 * constructor therefore rejects `number` at runtime, not merely in the types.
 */
import type { AssetId } from './asset.js'
import { isSameCodeDifferentIssuer } from './asset.js'

/** Decimal places used by all classic Stellar assets. */
export const STROOP_DECIMALS = 7

export class PrecisionError extends Error {
  public readonly code = 'PRECISION'
  constructor(message: string) {
    super(message)
    this.name = 'PrecisionError'
  }
}

export class AssetMismatchError extends Error {
  public readonly code = 'ASSET_MISMATCH'
  constructor(
    public readonly left: AssetId,
    public readonly right: AssetId,
    message: string,
  ) {
    super(message)
    this.name = 'AssetMismatchError'
  }
}

const AMOUNT_RE = /^(-?)(\d+)(?:\.(\d*))?$/

export class Money {
  private constructor(
    public readonly raw: bigint,
    public readonly asset: AssetId,
    public readonly decimals: number,
  ) {}

  /** Build from an exact integer count of the smallest unit. */
  static fromRaw(raw: bigint, asset: AssetId, decimals: number = STROOP_DECIMALS): Money {
    if (typeof raw !== 'bigint') {
      throw new PrecisionError(
        `Money.fromRaw requires a bigint, received ${typeof raw}. Amounts are never floats.`,
      )
    }
    assertDecimals(decimals)
    return new Money(raw, asset, decimals)
  }

  /**
   * Parse a decimal string as Horizon returns it (`"12.5000000"`).
   *
   * Rejects `number` input, and rejects a fractional part longer than the
   * asset's decimals rather than silently rounding — a value we cannot
   * represent exactly is a bug upstream, not something to paper over.
   */
  static parse(value: string, asset: AssetId, decimals: number = STROOP_DECIMALS): Money {
    if (typeof value !== 'string') {
      throw new PrecisionError(
        `Money.parse requires a string, received ${typeof value}. ` +
          `Passing a number would lose precision before parsing begins.`,
      )
    }
    assertDecimals(decimals)
    const match = AMOUNT_RE.exec(value.trim())
    if (match === null) {
      throw new PrecisionError(`Invalid amount ${JSON.stringify(value)}: expected a decimal string.`)
    }
    const [, sign = '', whole = '0', fraction = ''] = match
    if (fraction.length > decimals) {
      throw new PrecisionError(
        `Amount ${JSON.stringify(value)} has ${fraction.length} decimal places but the asset ` +
          `supports ${decimals}; refusing to round.`,
      )
    }
    const scaled = whole + fraction.padEnd(decimals, '0')
    const raw = BigInt(scaled)
    return new Money(sign === '-' ? -raw : raw, asset, decimals)
  }

  static zero(asset: AssetId, decimals: number = STROOP_DECIMALS): Money {
    return new Money(0n, asset, decimals)
  }

  private assertCompatible(other: Money, op: string): void {
    if (this.asset !== other.asset) {
      const hint = isSameCodeDifferentIssuer(this.asset, other.asset)
        ? ' These assets share a code but have different issuers, so they are not the same asset.'
        : ''
      throw new AssetMismatchError(
        this.asset,
        other.asset,
        `Cannot ${op} ${this.asset} and ${other.asset}.${hint}`,
      )
    }
    if (this.decimals !== other.decimals) {
      throw new PrecisionError(
        `Cannot ${op} amounts of ${this.asset} with differing decimals ` +
          `(${this.decimals} vs ${other.decimals}).`,
      )
    }
  }

  add(other: Money): Money {
    this.assertCompatible(other, 'add')
    return new Money(this.raw + other.raw, this.asset, this.decimals)
  }

  subtract(other: Money): Money {
    this.assertCompatible(other, 'subtract')
    return new Money(this.raw - other.raw, this.asset, this.decimals)
  }

  negate(): Money {
    return new Money(-this.raw, this.asset, this.decimals)
  }

  abs(): Money {
    return new Money(this.raw < 0n ? -this.raw : this.raw, this.asset, this.decimals)
  }

  /** -1, 0 or 1. Throws on a cross-asset comparison rather than ordering nonsense. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertCompatible(other, 'compare')
    if (this.raw < other.raw) return -1
    if (this.raw > other.raw) return 1
    return 0
  }

  equals(other: Money): boolean {
    return this.asset === other.asset && this.decimals === other.decimals && this.raw === other.raw
  }

  isZero(): boolean {
    return this.raw === 0n
  }

  isNegative(): boolean {
    return this.raw < 0n
  }

  isPositive(): boolean {
    return this.raw > 0n
  }

  /** Decimal string with exactly `decimals` places, round-tripping `parse()`. */
  toString(): string {
    const negative = this.raw < 0n
    const digits = (negative ? -this.raw : this.raw).toString().padStart(this.decimals + 1, '0')
    const whole = digits.slice(0, digits.length - this.decimals)
    const fraction = digits.slice(digits.length - this.decimals)
    const body = this.decimals === 0 ? whole : `${whole}.${fraction}`
    return negative ? `-${body}` : body
  }

  toJSON(): { raw: string; asset: AssetId; decimals: number } {
    return { raw: this.raw.toString(), asset: this.asset, decimals: this.decimals }
  }
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new PrecisionError(`Invalid decimals ${decimals}: expected an integer in [0, 38].`)
  }
}
