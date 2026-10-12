/**
 * The chart of accounts: which account code each journal role posts to.
 *
 * Journal arithmetic works on roles, not codes, so changing the chart only
 * affects lines posted from then on; it never re-posts history.
 *
 * | role                  | default                          | used for                                   |
 * |-----------------------|----------------------------------|--------------------------------------------|
 * | cash                  | assets:stellar:<network>:<G...>  | every movement on a wallet                 |
 * | issued                | liabilities:issued               | the issuer's own asset (no wallet balance) |
 * | receivable            | assets:receivable                | incoming payments applied to expectations  |
 * | payable               | liabilities:payable              | outgoing payments applied to payouts       |
 * | customer_credit       | liabilities:customer-credit      | overpaid or paid twice: owed back          |
 * | unapplied             | liabilities:unapplied-receipts   | money in, not yet explained                |
 * | unexplained           | assets:suspense                  | money out, not yet explained               |
 * | network_fees          | expenses:network-fees            | transaction fees                           |
 * | uncategorized_income  | income:uncategorized             | ignored incoming movements                 |
 * | uncategorized_expense | expenses:uncategorized           | ignored outgoing movements                 |
 *
 * Money out that nobody explained is a suspense *asset*, not a liability:
 * it was usually exchanged for something (a DEX trade, a bill booked
 * elsewhere), and netting it against unexplained receipts would hide both.
 */
import type { LineRole } from '../model/index.js'

export interface ChartOfAccounts {
  readonly cash: (network: string, account: string) => string
  readonly issued: string
  readonly receivable: string
  readonly payable: string
  readonly customer_credit: string
  readonly unapplied: string
  readonly unexplained: string
  readonly network_fees: string
  readonly uncategorized_income: string
  readonly uncategorized_expense: string
}

export const DEFAULT_CHART: ChartOfAccounts = {
  cash: (network, account) => `assets:stellar:${network}:${account}`,
  issued: 'liabilities:issued',
  receivable: 'assets:receivable',
  payable: 'liabilities:payable',
  customer_credit: 'liabilities:customer-credit',
  unapplied: 'liabilities:unapplied-receipts',
  unexplained: 'assets:suspense',
  network_fees: 'expenses:network-fees',
  uncategorized_income: 'income:uncategorized',
  uncategorized_expense: 'expenses:uncategorized',
}

/** The account a role posts to for a movement on `account` in `network`. */
export function accountFor(chart: ChartOfAccounts, role: LineRole, network: string, account: string): string {
  return role === 'cash' ? chart.cash(network, account) : chart[role]
}
