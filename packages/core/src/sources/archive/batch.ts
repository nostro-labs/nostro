/** Read the inclusive ledger range in the XDR header of a decompressed SEP-54 batch. */
export function archiveBatchRange(bytes: Uint8Array): { firstLedger: number; lastLedger: number } {
  // Two uint32 sequence numbers, an XDR array length, then at least one LedgerCloseMeta.
  if (bytes.byteLength < 16) throw new RangeError('Truncated LedgerCloseMetaBatch')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const firstLedger = view.getUint32(0)
  const lastLedger = view.getUint32(4)
  const count = view.getUint32(8)
  if (firstLedger < 1 || lastLedger < firstLedger || lastLedger - firstLedger + 1 !== count) {
    throw new RangeError('LedgerCloseMetaBatch range disagrees with its record count')
  }
  return { firstLedger, lastLedger }
}
