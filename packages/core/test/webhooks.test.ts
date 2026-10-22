import { describe, expect, it } from 'vitest'
import { MemoryStore, deliverWebhooks, eventCursorKey, signWebhook, verifyWebhook } from '../src/index.js'

const T = 'acme'
const A = `G${'A'.repeat(55)}`
const SECRET = 's'.repeat(64)
const NOW = new Date('2026-10-22T12:00:00Z')
const now = () => NOW

/** A store with three exceptions opened, so three events. */
async function withEvents(): Promise<MemoryStore> {
  const store = new MemoryStore()
  for (const detail of ['one', 'two', 'three']) {
    await store.transaction((tx) => tx.openException({ tenantId: T, code: 'MEMO_MISSING', account: A, detail }))
  }
  return store
}

interface Received {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

/** A receiver answering each request with the next status (default 200). */
function receiver(statuses: (number | Error)[] = []) {
  const received: Received[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    received.push({ url: String(url), headers: init!.headers as Record<string, string>, body: init!.body as string })
    const next = statuses.shift() ?? 200
    if (next instanceof Error) throw next
    return new Response('ok', { status: next })
  }) as typeof globalThis.fetch
  return { received, fetch }
}

const deliver = (store: MemoryStore, fetch: typeof globalThis.fetch, extra: object = {}) =>
  deliverWebhooks({ store, tenantId: T, url: 'https://hooks.example/nostro', secret: SECRET, fetch, now, ...extra })

describe('deliverWebhooks', () => {
  it('posts each event once, in order, signed, and remembers how far it got', async () => {
    const store = await withEvents()
    const { received, fetch } = receiver()
    const report = await deliver(store, fetch)
    const events = await store.listEvents({ tenantId: T })
    expect(report).toEqual({ delivered: 3, position: events[2]!.seq, failure: null, contended: false })
    expect(received.map((r) => JSON.parse(r.body).data.exception.detail)).toEqual(['one', 'two', 'three'])

    const first = received[0]!
    expect(first.url).toBe('https://hooks.example/nostro')
    expect(JSON.parse(first.body)).toMatchObject({ id: events[0]!.id, seq: events[0]!.seq, type: 'exception.opened' })
    expect(first.headers).toMatchObject({
      'content-type': 'application/json',
      'nostro-event-id': events[0]!.id,
      'nostro-event-type': 'exception.opened',
    })
    expect(first.headers['nostro-signature']).toBe(signWebhook(SECRET, first.body, NOW.getTime() / 1000))
    expect(verifyWebhook({ secret: SECRET, header: first.headers['nostro-signature'], body: first.body, now })).toBe(true)

    expect(await deliver(store, fetch)).toMatchObject({ delivered: 0, position: events[2]!.seq })
    expect(received).toHaveLength(3)
    await store.transaction((tx) => tx.openException({ tenantId: T, code: 'WRONG_ASSET', account: A, detail: 'four' }))
    expect(await deliver(store, fetch)).toMatchObject({ delivered: 1 })
    expect(JSON.parse(received[3]!.body).data.exception.detail).toBe('four')
  })

  it('stops at the first failure and retries that event next time, never skipping it', async () => {
    const store = await withEvents()
    const events = await store.listEvents({ tenantId: T })
    const { received, fetch } = receiver([200, 503, new Error('connect ECONNREFUSED'), 302])
    expect(await deliver(store, fetch)).toEqual({
      delivered: 1,
      position: events[0]!.seq,
      failure: { eventId: events[1]!.id, reason: 'HTTP 503' },
      contended: false,
    })
    expect((await deliver(store, fetch)).failure).toEqual({ eventId: events[1]!.id, reason: 'connect ECONNREFUSED' })
    // A redirect is not followed: a signed body goes only where it was configured to go.
    expect((await deliver(store, fetch)).failure).toEqual({ eventId: events[1]!.id, reason: 'HTTP 302' })
    expect(await deliver(store, fetch)).toMatchObject({ delivered: 2, failure: null })
    expect(received.map((r) => JSON.parse(r.body).data.exception.detail)).toEqual(['one', 'two', 'two', 'two', 'two', 'three'])
  })

  it('keeps a position per consumer, and stops if another deliverer moves it', async () => {
    const store = await withEvents()
    expect((await deliver(store, receiver().fetch, { consumer: 'a', limit: 1 })).delivered).toBe(1)
    expect((await deliver(store, receiver().fetch, { consumer: 'b' })).delivered).toBe(3)
    const events = await store.listEvents({ tenantId: T })

    // While consumer "a" posts event 2, someone else delivers it and saves the position.
    const racing = (async () => {
      await store.transaction((tx) => tx.setCursor(eventCursorKey(T, 'a'), String(events[1]!.seq)))
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    expect(await deliver(store, racing, { consumer: 'a' })).toEqual({
      delivered: 0,
      position: events[0]!.seq,
      failure: null,
      contended: true,
    })
    expect(await store.getCursor(eventCursorKey(T, 'a'))).toBe(String(events[1]!.seq))
  })

  it('refuses a short secret', async () => {
    await expect(deliver(new MemoryStore(), receiver().fetch, { secret: 'short' })).rejects.toThrow(/at least 32/)
  })
})

describe('verifyWebhook', () => {
  const body = '{"id":"e1"}'
  const t = NOW.getTime() / 1000
  const header = signWebhook(SECRET, body, t)
  const verify = (over: Partial<Parameters<typeof verifyWebhook>[0]>) =>
    verifyWebhook({ secret: SECRET, header, body, now, ...over })

  it('accepts what was signed, and nothing changed', () => {
    expect(verify({})).toBe(true)
    expect(verify({ body: '{"id":"e2"}' })).toBe(false)
    expect(verify({ secret: 'x'.repeat(64) })).toBe(false)
    expect(verify({ header: header.replace(/v1=./, 'v1=0') })).toBe(false)
  })

  it('refuses a stale or future timestamp, so a captured request cannot be replayed', () => {
    expect(verify({ now: () => new Date(NOW.getTime() + 299_000) })).toBe(true)
    expect(verify({ now: () => new Date(NOW.getTime() + 301_000) })).toBe(false)
    expect(verify({ now: () => new Date(NOW.getTime() - 301_000) })).toBe(false)
    expect(verify({ now: () => new Date(NOW.getTime() + 3_000_000), toleranceSeconds: 3_600 })).toBe(true)
  })

  it('refuses a missing or malformed header', () => {
    for (const h of [null, undefined, '', 'v1=abc', `t=${t}`, `t=soon,v1=${'a'.repeat(64)}`, `t=${t},v1=${'z'.repeat(64)}`, `t=${t},v1=abcd`]) {
      expect(verify({ header: h })).toBe(false)
    }
  })
})
