import { describe, expect, it } from 'vitest'
import { archiveBatchRange } from '../src/index.js'

describe('archiveBatchRange', () => {
  // First 16 decompressed bytes of fixtures/archive/pubnet/FFFF0687--63864.xdr.zst.
  const prefix = Uint8Array.of(0, 0, 0xf9, 0x78, 0, 0, 0xf9, 0x78, 0, 0, 0, 1, 0, 0, 0, 0)

  it('reads the inclusive range from a slice of a larger buffer', () => {
    const bytes = Uint8Array.of(99, ...prefix)
    expect(archiveBatchRange(bytes.subarray(1))).toEqual({ firstLedger: 63864, lastLedger: 63864 })
  })

  it('rejects a truncated header or inconsistent count', () => {
    expect(() => archiveBatchRange(prefix.subarray(0, 8))).toThrow(RangeError)
    const bad = prefix.slice()
    bad[11] = 2
    expect(() => archiveBatchRange(bad)).toThrow(RangeError)
  })
})
