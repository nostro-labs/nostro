import { COMMON, NETWORK, accounts, flag, network, positionals, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, NETWORK_HELP, horizonClient, movementSources, withStore } from '../command.js'
import { json, table, write } from '../io.js'
import type { StreamProgress } from '../work.js'
import { syncAll } from '../work.js'

export const sync: Command = {
  name: 'sync',
  summary: "Ingest the accounts' history from Horizon",
  usage: '--account <G...> [options]',
  help: `Reads every effect and every fee for each account from Horizon and records them as movements,
from the start of the history Horizon keeps, then from where the last sync stopped. Runs until each
account is caught up, unless --once is given. Safe to stop at any point and to run again: the
position is saved in the same transaction as the movements it covers.

Options:
${NETWORK_HELP}
  --once              Read at most one round of pages per account, then stop
${COMMON_HELP}`,
  options: { ...COMMON, ...NETWORK, once: { type: 'boolean' } },
  async run(args, io) {
    positionals(args, 0)
    const tenantId = tenant(args, io)
    const net = network(args, io)
    const list = accounts(args, io)
    const once = flag(args, 'once')
    const asJson = flag(args, 'json')
    const progress = io.stderr.isTTY === true && !asJson

    const client = horizonClient(net, io)
    const results = await withStore(args, io, (store) =>
      syncAll({
        store,
        tenantId,
        accounts: list,
        sources: movementSources(client, net),
        once,
        onRound: async (source, streams) => {
          if (!progress) return
          for (const r of streams) await write(io.stderr, `${source.name} ${r.account}: ${r.inserted} new so far\n`)
        },
      }),
    )

    const failed = results.some((r) => r.error !== null)
    if (asJson) {
      await write(
        io.stdout,
        json({
          network: net.name,
          horizon: net.horizon,
          streams: results.map((r) => ({ ...r, error: r.error === null ? null : r.error.message })),
        }),
      )
      return failed ? 1 : 0
    }

    const state = (r: StreamProgress) =>
      r.error !== null ? `failed: ${r.error.message}` : r.contended ? 'another sync is running' : r.caughtUp ? 'caught up' : 'more to read'
    await write(
      io.stdout,
      table([
        ['ACCOUNT', 'SOURCE', 'NEW', 'ALREADY HAD', 'STATE'],
        ...results.map((r) => [r.account, r.source, String(r.inserted), String(r.duplicates), state(r)]),
      ]),
    )
    const conflicts = results.reduce((n, r) => n + r.conflicts, 0)
    if (conflicts > 0) {
      await write(
        io.stdout,
        `${conflicts} re-delivered record(s) disagreed with what was recorded; each opened a ` +
          `SOURCE_GAP_DETECTED exception (nostro exceptions --code SOURCE_GAP_DETECTED).\n`,
      )
    }
    return failed ? 1 : 0
  },
}
