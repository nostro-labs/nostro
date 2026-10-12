/**
 * The journal as CSV: one row per line, RFC 4180, CRLF line endings.
 *
 * Amounts are exact decimal strings in the debit or credit column, never
 * floats. Text cells that a spreadsheet would treat as a formula (starting
 * with `=`, `+`, `-`, `@`, tab or carriage return) are prefixed with `'`,
 * because references and account codes come from users and these files are
 * opened in spreadsheets. Payer-controlled memo text is never written.
 */
import type { JournalEntry } from '../model/index.js'
import type { Store } from '../store/index.js'

export const JOURNAL_CSV_COLUMNS = [
  'entry_id',
  'seq',
  'kind',
  'posted_at',
  'effective_at',
  'description',
  'line_no',
  'account',
  'role',
  'asset',
  'debit',
  'credit',
  'movement_id',
  'tx_hash',
  'expectation_reference',
  'exception_id',
  'exception_code',
] as const

export interface JournalCsvOptions {
  readonly store: Store
  readonly tenantId: string
  /** Entries effective on or after this instant. */
  readonly from?: Date
  /** Entries effective strictly before this instant. */
  readonly to?: Date
  /** Entries read per page. Default 500. */
  readonly pageSize?: number
}

const FORMULA = /^[=+\-@\t\r]/

/** One CSV cell. `text` cells get the formula guard; numbers and ids do not need it. */
function cell(value: string | number | null, text = false): string {
  if (value === null) return ''
  let s = String(value)
  if (text && FORMULA.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

const row = (cells: readonly string[]) => `${cells.join(',')}\r\n`

/** The CSV, header first, a row at a time; suitable for streaming large ledgers. */
export async function* journalCsvRows(options: JournalCsvOptions): AsyncGenerator<string> {
  const { store, tenantId } = options
  const pageSize = options.pageSize ?? 500
  const txHash = new Map<string, string | null>()
  const reference = new Map<string, string | null>()
  const code = new Map<string, string | null>()

  yield row(JOURNAL_CSV_COLUMNS.map((c) => c))
  let afterSeq: number | undefined
  for (;;) {
    const page: JournalEntry[] = await store.listJournalEntries({
      tenantId,
      limit: pageSize,
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(options.from === undefined ? {} : { effectiveFrom: options.from }),
      ...(options.to === undefined ? {} : { effectiveBefore: options.to }),
    })
    for (const entry of page) {
      if (entry.movementId !== null && !txHash.has(entry.movementId)) {
        txHash.set(entry.movementId, (await store.getMovement(tenantId, entry.movementId))?.txHash ?? null)
      }
      for (const [i, line] of entry.lines.entries()) {
        if (line.expectationId !== null && !reference.has(line.expectationId)) {
          reference.set(line.expectationId, (await store.getExpectation(tenantId, line.expectationId))?.reference ?? null)
        }
        if (line.exceptionId !== null && !code.has(line.exceptionId)) {
          code.set(line.exceptionId, (await store.getException(tenantId, line.exceptionId))?.code ?? null)
        }
        const amount = line.amount.toString()
        yield row([
          cell(entry.id),
          cell(entry.seq),
          cell(entry.kind),
          cell(entry.postedAt.toISOString()),
          cell(entry.effectiveAt.toISOString()),
          cell(entry.description, true),
          cell(i + 1),
          cell(line.account, true),
          cell(line.role),
          cell(line.amount.asset),
          cell(line.side === 'debit' ? amount : null),
          cell(line.side === 'credit' ? amount : null),
          cell(entry.movementId),
          cell(entry.movementId === null ? null : (txHash.get(entry.movementId) ?? null)),
          cell(line.expectationId === null ? null : (reference.get(line.expectationId) ?? null), true),
          cell(line.exceptionId),
          cell(line.exceptionId === null ? null : (code.get(line.exceptionId) ?? null)),
        ])
      }
    }
    if (page.length < pageSize) return
    afterSeq = page[page.length - 1]!.seq
  }
}

/** The whole CSV as one string. Prefer `journalCsvRows` for large ledgers. */
export async function journalCsv(options: JournalCsvOptions): Promise<string> {
  let out = ''
  for await (const line of journalCsvRows(options)) out += line
  return out
}
