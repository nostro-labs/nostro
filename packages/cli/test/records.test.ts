import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SqliteStore } from 'nostro-store-sqlite'
import { FakeHorizon } from 'nostro-testkit'
import { A, B, migrated, nostro } from './helpers.js'

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

/** A synced workspace: A is paid 25 XLM for INV-1042, then pays B 5 XLM and the fee. */
async function synced(): Promise<string> {
  const h = new FakeHorizon()
  h.payment(10, B, A, '25', { memo: 'inv #1042' })
  h.payment(11, A, B, '5', { memo: 'refund' })
  const cwd = await migrated()
  const { code, stderr } = await nostro(cwd, ['sync', '--account', A], { fetch: h.fetch })
  if (code !== 0) throw new Error(stderr)
  return cwd
}

describe('nostro expect', () => {
  it('records what is owed, which reconcile then settles from the memo', async () => {
    const cwd = await synced()
    const run = await nostro(cwd, ['expect', 'INV-1042', '--account', A, '--amount', '25'])
    expect(run).toMatchObject({ code: 0, stdout: `Recorded INV-1042: 25.0000000 XLM owed to ${A}.\n` })
    await nostro(cwd, ['expect', 'INV-1043', '--account', A, '--amount', '10', '--asset', 'xlm', '--due', '2026-11-30'])
    expect((await nostro(cwd, ['reconcile'])).stdout).toMatch(/^Decided 3 movement\(s\): 1 allocated,/)

    const listed = await nostro(cwd, ['expectations'])
    expect(listed.stdout.split('\n')).toEqual([
      'REFERENCE  STATUS   AMOUNT      PAID        ASSET  DUE         ACCOUNT',
      `INV-1042   settled  25.0000000  25.0000000  XLM                ${A}`,
      `INV-1043   open     10.0000000  0.0000000   XLM    2026-11-30  ${A}`,
      '',
    ])
    expect((await nostro(cwd, ['expectations', '--status', 'open,partially_paid'])).stdout).not.toContain('INV-1042')
    expect((await nostro(cwd, ['expectations', '--account', B])).stdout).toBe('No expectations.\n')
    const asJson = JSON.parse((await nostro(cwd, ['expectations', '--json', '--limit', '1'])).stdout)
    expect(asJson).toEqual([expect.objectContaining({ reference: 'INV-1042', amount: '25.0000000', paid: '25.0000000', status: 'settled' })])
  })

  it('takes every field, and prints them exactly in JSON', async () => {
    const cwd = await migrated()
    const run = await nostro(cwd, [
      'expect',
      'PAYROLL-7',
      '--account', A,
      '--amount', '1200.5',
      '--asset', `USDC:${ISSUER}`,
      '--debit',
      '--muxed-id', '18446744073709551615',
      '--memo-id', '7',
      '--payer', B,
      '--due', '2026-11-01',
      '--expires', '2026-12-01T17:00:00+01:00',
      '--meta', 'po=77',
      '--meta', 'note=a=b',
      '--json',
    ]) // prettier-ignore
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({
      reference: 'PAYROLL-7',
      account: A,
      direction: 'debit',
      amount: '1200.5000000',
      paid: '0.0000000',
      asset: `USDC:${ISSUER}`,
      muxedId: '18446744073709551615',
      memo: { type: 'id', value: '7' },
      payers: [B],
      dueAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2026-12-01T16:00:00.000Z',
      status: 'open',
      metadata: { po: '77', note: 'a=b' },
    })
    const listed = await nostro(cwd, ['expectations'])
    expect(listed.stdout).toContain(`PAYROLL-7  open (debit)  1200.5000000  0.0000000  USDC:${ISSUER}  2026-11-01`)
    const text = await nostro(cwd, ['expect', 'PAYROLL-8', '--account', A, '--amount', '1', '--debit', '--memo-text', 'May payroll'])
    expect(text.stdout).toBe(`Recorded PAYROLL-8: 1.0000000 XLM to pay from ${A}.\n`)
  })

  it('refuses a reference already recorded in the tenant, but not in another', async () => {
    const cwd = await migrated()
    const argv = ['expect', 'INV-1', '--account', A, '--amount', '1']
    expect((await nostro(cwd, argv)).code).toBe(0)
    expect(await nostro(cwd, argv)).toMatchObject({
      code: 1,
      stderr: 'nostro: INV-1 is already recorded in this tenant; references are unique.\n',
    })
    expect((await nostro(cwd, [...argv, '--tenant', 'other'])).code).toBe(0)
  })

  it('exits 2, recording nothing, on anything it would have to guess at', async () => {
    const cwd = await migrated()
    const ok = ['--account', A, '--amount', '1']
    for (const [argv, message] of [
      [['--account', A, '--amount', '1'], 'Give the reference'],
      [[' ', ...ok], 'Give the reference'],
      [['R', 'S', ...ok], 'Unexpected argument "S"'],
      [['R', '--amount', '1'], '--account must be the G... account'],
      [['R', '--account', 'M123', '--amount', '1'], '--account must be the G... account'],
      [['R', '--account', A], '--amount is required'],
      [['R', '--account', A, '--amount', 'ten'], '--amount: Invalid amount "ten"'],
      [['R', '--account', A, '--amount', '1.00000001'], 'refusing to round'],
      [['R', '--account', A, '--amount=-1'], 'amount: must be positive'],
      [['R', ...ok, '--asset', 'USDC'], '--asset must be native (or XLM) or CODE:ISSUER, not "USDC"'],
      [['R', ...ok, '--memo-text', 'x', '--memo-id', '1'], 'not both'],
      [['R', ...ok, '--memo-text', 'x'.repeat(29)], '1 to 28 bytes'],
      [['R', ...ok, '--memo-text', '\u00e9'.repeat(15)], '1 to 28 bytes'],
      [['R', ...ok, '--memo-id', '18446744073709551616'], '--memo-id must be a whole number below 2^64'],
      [['R', ...ok, '--muxed-id=-1'], '--muxed-id must be a whole number below 2^64'],
      [['R', ...ok, '--payer', 'GABC'], '--payer "GABC" is not a G... account id'],
      [['R', ...ok, '--due', 'tomorrow'], '--due must be a date'],
      [['R', ...ok, '--due', '2026-02-30'], '--due must be a date'],
      [['R', ...ok, '--due', '2026-13-01'], '--due must be a date'],
      [['R', ...ok, '--expires', '2026-10-31T17:00'], '--expires must be a date'],
      [['R', ...ok, '--meta', 'novalue'], '--meta must be key=value'],
      [['R', ...ok, '--meta', '=x'], '--meta must be key=value'],
      [['R'.repeat(257), ...ok], 'reference: must be at most 256 characters'],
    ] as const) {
      const run = await nostro(cwd, ['expect', ...argv])
      expect(run.code, argv.join(' ')).toBe(2)
      expect(run.stderr).toContain(message)
    }
    expect((await nostro(cwd, ['expectations'])).stdout).toBe('No expectations.\n')
    for (const argv of [['--status', 'paid'], ['--account', 'GABC'], ['--limit', '0']]) {
      expect((await nostro(cwd, ['expectations', ...argv])).code).toBe(2)
    }
  })
})

describe('nostro exceptions', () => {
  it('lists the open exceptions, oldest first, filtered by code or status', async () => {
    const cwd = await synced()
    expect((await nostro(cwd, ['exceptions'])).stdout).toBe('No open exceptions.\n')
    await nostro(cwd, ['reconcile'])
    const open = await nostro(cwd, ['exceptions'])
    const lines = open.stdout.trimEnd().split('\n')
    expect(lines[0]).toMatch(/^OPENED \(UTC\) +CODE +STATUS +AMOUNT +MOVEMENT +DETAIL$/)
    expect(lines.slice(1).map((l) => l.split(/ {2,}/).slice(1, 4))).toEqual([
      ['UNMATCHED_NO_CANDIDATE', 'open', '25.0000000 XLM'],
      ['UNEXPECTED_DEBIT', 'open', '5.0000000 XLM'],
    ])
    const debits = await nostro(cwd, ['exceptions', '--code', 'UNEXPECTED_DEBIT', '--json'])
    expect(JSON.parse(debits.stdout)).toEqual([
      expect.objectContaining({ code: 'UNEXPECTED_DEBIT', status: 'open', account: A, amount: '5.0000000', asset: 'native' }),
    ])
    expect((await nostro(cwd, ['exceptions', '--status', 'resolved'])).stdout).toBe('No exceptions.\n')
    expect(JSON.parse((await nostro(cwd, ['exceptions', '--status', 'all', '--limit', '1', '--json'])).stdout)).toHaveLength(1)
  })

  it('escapes control characters in what it prints, and keeps them exact in JSON', async () => {
    const cwd = await migrated()
    const store = new SqliteStore({ filename: join(cwd, 'nostro.db') })
    await store.transaction((tx) =>
      tx.openException({ tenantId: 'default', code: 'MEMO_MALFORMED', account: A, detail: 'memo \u001b[2Jgone' }),
    )
    await store.close()
    expect((await nostro(cwd, ['exceptions'])).stdout).toContain('memo \\u001b[2Jgone\n')
    expect(JSON.parse((await nostro(cwd, ['exceptions', '--json'])).stdout)[0].detail).toBe('memo \u001b[2Jgone')
  })

  it('exits 2 on a status or code it does not know', async () => {
    const cwd = await migrated()
    for (const argv of [['--status', 'closed'], ['--code', 'unexpected_credit'], ['--limit', 'x']]) {
      const run = await nostro(cwd, ['exceptions', ...argv])
      expect(run.code).toBe(2)
    }
    expect((await nostro(cwd, ['exceptions', '--code', 'NOPE'])).stderr).toContain('--code takes one of UNMATCHED_NO_CANDIDATE,')
  })
})
