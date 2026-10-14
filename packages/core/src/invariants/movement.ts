/**
 * Checking one movement: its disposition (I1) and its journal entries (I3).
 *
 * Stores refuse writes that break these rules, so on a healthy store this
 * finds nothing. It is for what a write check cannot catch: a state reached
 * by legal steps that no longer supports the disposition (the exception on a
 * `partial` movement resolved while the movement stays `partial`), books
 * that lag a decision, and rows changed outside nostro (SQLite cannot check
 * an entry's balance itself).
 */
import type { Allocation, ExceptionRecord, JournalEntry, Movement } from '../model/index.js'
import { planPosting } from '../journal/index.js'
import type { ConstraintName } from '../store/index.js'
import { ConstraintError, checkDisposition, checkJournalEntry, sumAmounts } from '../store/index.js'
import type { Finding, FindingCode, Invariant, Severity } from './types.js'

/** A movement and everything recorded against it. Entries in posting order. */
export interface MovementRecords {
  readonly movement: Movement
  readonly allocations: readonly Allocation[]
  readonly exceptions: readonly ExceptionRecord[]
  readonly entries: readonly JournalEntry[]
}

const JOURNAL_CODES: Partial<Record<ConstraintName, FindingCode>> = {
  journal_unbalanced: 'journal_unbalanced',
  journal_posting_conflict: 'journal_posting_sequence',
  journal_asset: 'journal_asset',
  journal_cash_mismatch: 'journal_cash_mismatch',
}

export function checkMovement({ movement, allocations, exceptions, entries }: MovementRecords): Finding[] {
  const findings: Finding[] = []
  const add = (invariant: Invariant, severity: Severity, code: FindingCode, detail: string, entryId: string | null = null) =>
    findings.push({
      invariant,
      severity,
      code,
      detail,
      movementId: movement.id,
      entryId,
      account: movement.account,
      asset: movement.amount.asset,
    })

  // I1. Allocations in another asset make every sum below meaningless.
  const foreign = allocations.filter(
    (a) => a.amount.asset !== movement.amount.asset || a.amount.decimals !== movement.amount.decimals,
  )
  for (const a of foreign) {
    add('I1', 'error', 'allocation_asset', `allocation ${a.id} is in ${a.amount.asset}, the movement in ${movement.amount.asset}`)
  }
  if (foreign.length > 0) return findings

  const allocated = sumAmounts(allocations.map((a) => a.amount), movement.amount)
  if (allocated.compare(movement.amount) > 0) {
    add('I1', 'error', 'allocation_over_movement', `allocations total ${allocated.toString()} of a ${movement.amount.toString()} movement`)
  }
  try {
    checkDisposition(movement, allocations, exceptions, movement.disposition, movement.ignoredReason ?? undefined)
  } catch (err) {
    if (!(err instanceof ConstraintError)) throw err
    const remedy =
      movement.disposition === 'partial'
        ? '; allocate the rest, or mark it `exception` or `ignored` now that its exceptions are closed'
        : ''
    add('I1', 'error', 'disposition_unsupported', `${err.message}${remedy}`)
  }

  // I3. Replay the entries through the rule every store applies when posting.
  // The first entry that breaks it is the finding; later ones would only
  // repeat it.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    try {
      checkJournalEntry(entry, movement, entries.slice(0, i))
    } catch (err) {
      if (!(err instanceof ConstraintError)) throw err
      const code = JOURNAL_CODES[err.constraint]
      if (code === undefined) throw err
      add('I3', 'error', code, err.message, entry.id)
      return findings
    }
  }
  if (findings.length > 0) return findings

  if (planPosting(movement, allocations, exceptions, entries) !== null) {
    add(
      'I3',
      'warning',
      'journal_stale',
      `movement ${movement.id} is ${movement.disposition}, but its journal entries do not say so yet; run postJournal()`,
    )
  }
  return findings
}
