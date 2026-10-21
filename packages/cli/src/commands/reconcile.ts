import { COMMON, flag, integer, positionals, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { clean, json, write } from '../io.js'
import { reconcileAll } from '../work.js'

export const reconcile: Command = {
  name: 'reconcile',
  summary: 'Decide every pending movement and post it to the journal',
  usage: '[options]',
  help: `Matches each pending movement against what you are owed and records the outcome: an allocation,
an exception for a person to look at, or an explicit ignore (network fees). Each decision is posted
to the journal in the same transaction. Runs until nothing is pending. Safe to run alongside
another reconcile: each movement is decided once.

Options:
  --batch <n>         Movements per round (default 100)
${COMMON_HELP}`,
  options: { ...COMMON, batch: { type: 'string' } },
  async run(args, io) {
    positionals(args, 0)
    const tenantId = tenant(args, io)
    const limit = integer(args, 'batch', 100, 1, 10_000)

    const { exceptions, errors, ...totals } = await withStore(args, io, (store) => reconcileAll(store, tenantId, limit))

    const failed = errors.size > 0
    if (flag(args, 'json')) {
      const list = [...errors].map(([movementId, error]) => ({ movementId, error }))
      await write(io.stdout, json({ ...totals, exceptions, errors: list }))
      return failed ? 1 : 0
    }

    const raised = Object.values(exceptions).reduce((n, c) => n + c, 0)
    if (totals.decided === 0 && !failed) {
      await write(io.stdout, 'Nothing to reconcile: no movement is pending.\n')
      return 0
    }
    const parts = [
      [totals.allocated, 'allocated'],
      [totals.partial, 'overpaid (allocated, the rest raised as OVERPAYMENT)'],
      [raised, 'raised as exceptions'],
      [totals.ignored, 'ignored'],
    ] as const
    const decided = parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`)
    let out = `Decided ${totals.decided} movement(s)${decided.length === 0 ? '' : `: ${decided.join(', ')}`}.\n`
    if (raised > 0) {
      const codes = Object.entries(exceptions).map(([code, n]) => `${code} ${n}`)
      out += `Exceptions: ${codes.join(', ')}\n`
    }
    out += `Posted ${totals.journalEntries} journal entr${totals.journalEntries === 1 ? 'y' : 'ies'}.\n`
    await write(io.stdout, out)
    for (const [movementId, error] of errors) {
      await write(io.stderr, `Failed on movement ${movementId}: ${clean(error)}\n`)
    }
    return failed ? 1 : 0
  },
}
