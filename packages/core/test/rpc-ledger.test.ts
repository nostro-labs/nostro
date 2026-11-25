import { afterEach, expect, it, vi } from 'vitest'
import { StellarRpcClient } from '../src/sources/rpc/client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('retains the responding server tip alongside a page with an older event', async () => {
  vi.stubGlobal('fetch', async () => Response.json({
    result: { events: [{ ledger: 20 }], cursor: 'page-2', latestLedger: 50 },
  }))
  const client = new StellarRpcClient({ url: 'https://rpc.test' })
  expect(await client.getEvents({ limit: 1 })).toMatchObject({
    events: [{ ledger: 20 }], cursor: 'page-2', latestLedger: 50,
  })
})

it('leaves the tip unknown when the server omits it', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ result: { events: [], cursor: null } }))
  const client = new StellarRpcClient({ url: 'https://rpc.test' })
  expect(await client.getEvents({})).toEqual({ events: [], cursor: null })
})
