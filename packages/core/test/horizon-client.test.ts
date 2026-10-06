import { describe, expect, it } from 'vitest'
import { HorizonClient, HorizonError, parseRetryAfter } from '../src/index.js'

type Reply = Response | ((signal: AbortSignal) => Promise<Response>) | Error

/** A fetch that serves queued replies and records the URLs it was asked for. */
function fakeFetch(replies: Reply[]) {
  const urls: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input))
    const reply = replies.shift()
    if (reply === undefined) throw new Error('unexpected request')
    if (reply instanceof Error) throw reply
    if (typeof reply === 'function') return reply(init!.signal!)
    return reply
  }) as typeof globalThis.fetch
  return { fetch, urls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/hal+json', ...headers },
  })

const problem = (status: number, type: string, extras?: Record<string, unknown>, headers: Record<string, string> = {}) =>
  json({ type: `https://stellar.org/horizon-errors/${type}`, title: type, status, detail: `${type} detail`, extras }, status, headers)

const collection = (...tokens: string[]) => json({ _embedded: { records: tokens.map((t) => ({ paging_token: t })) } })

function client(replies: Reply[], options: Partial<ConstructorParameters<typeof HorizonClient>[0]> = {}) {
  const { fetch, urls } = fakeFetch(replies)
  const sleeps: number[] = []
  const horizon = new HorizonClient({
    url: 'https://horizon.example/prefix/',
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 1,
    ...options,
  })
  return { horizon, urls, sleeps }
}

describe('HorizonClient', () => {
  it('builds URLs that keep a path prefix and drop undefined parameters', () => {
    const { horizon } = client([])
    expect(horizon.url('/accounts/GA/effects', { order: 'asc', limit: 200, cursor: undefined })).toBe(
      'https://horizon.example/prefix/accounts/GA/effects?order=asc&limit=200',
    )
    expect(horizon.url('ledgers')).toBe('https://horizon.example/prefix/ledgers')
  })

  it('returns a page of records with the last paging token as the cursor', async () => {
    const { horizon, urls } = client([collection('10-1', '10-2'), collection()])
    const page = await horizon.page('/effects', { cursor: '9-1' })
    expect(page.records).toHaveLength(2)
    expect(page.lastCursor).toBe('10-2')
    expect(urls[0]).toBe('https://horizon.example/prefix/effects?cursor=9-1')
    expect((await horizon.page('/effects')).lastCursor).toBeNull()
  })

  it('refuses a response that is not a collection', async () => {
    const { horizon } = client([json({ id: 'x' })])
    await expect(horizon.page('/effects')).rejects.toMatchObject({ name: 'HorizonError', retryable: false })
  })

  it('retries 5xx and 429 with full-jitter exponential backoff', async () => {
    const { horizon, sleeps } = client([
      problem(503, 'service_unavailable'),
      problem(504, 'timeout'),
      problem(429, 'rate_limit_exceeded'),
      json({ ok: true }),
    ])
    await expect(horizon.get('/')).resolves.toEqual({ ok: true })
    expect(sleeps).toEqual([500, 1_000, 2_000])
  })

  it('caps backoff at backoffMaxMs', async () => {
    const replies = Array.from({ length: 5 }, () => problem(500, 'server_error'))
    const { horizon, sleeps } = client([...replies, json({})], { retries: 5, backoffMaxMs: 3_000 })
    await horizon.get('/')
    expect(sleeps).toEqual([500, 1_000, 2_000, 3_000, 3_000])
  })

  it('waits at least as long as Retry-After asks', async () => {
    const { horizon, sleeps } = client([problem(429, 'rate_limit_exceeded', undefined, { 'retry-after': '7' }), json({})])
    await horizon.get('/')
    expect(sleeps).toEqual([7_000])
  })

  it('gives up rather than sleep past maxRetryAfterMs', async () => {
    const { horizon, sleeps } = client([problem(429, 'rate_limit_exceeded', undefined, { 'retry-after': '3600' })])
    const err = await horizon.get('/').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HorizonError)
    expect(err).toMatchObject({ status: 429, retryAfterMs: 3_600_000 })
    expect(sleeps).toEqual([])
  })

  it('does not retry client errors, and keeps the problem details', async () => {
    const { horizon, urls } = client([problem(400, 'bad_request', { invalid_field: 'cursor', reason: 'cursor: invalid value' })])
    const err = (await horizon.get('/effects').catch((e: unknown) => e)) as HorizonError
    expect(urls).toHaveLength(1)
    expect(err.status).toBe(400)
    expect(err.retryable).toBe(false)
    expect(err.problemType).toBe('https://stellar.org/horizon-errors/bad_request')
    expect(err.extras).toEqual({ invalid_field: 'cursor', reason: 'cursor: invalid value' })
    expect(err.message).toContain('bad_request detail')
  })

  it('retries transport failures and stops after the configured retries', async () => {
    const { horizon, urls } = client([new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET')], {
      retries: 2,
    })
    await expect(horizon.get('/')).rejects.toMatchObject({ status: 0, retryable: true, message: expect.stringContaining('ECONNRESET') })
    expect(urls).toHaveLength(3)
  })

  it('times out a request that never answers', async () => {
    const hang = (signal: AbortSignal) =>
      new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    const { horizon } = client([hang], { timeoutMs: 20, retries: 0 })
    await expect(horizon.get('/')).rejects.toMatchObject({ status: 0, message: expect.stringContaining('timed out after 20ms') })
  })

  it('times out a body that stalls after the headers arrive', async () => {
    const stall = async (signal: AbortSignal) =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      }) as unknown as Response
    const { horizon } = client([stall], { timeoutMs: 20, retries: 0 })
    await expect(horizon.get('/')).rejects.toMatchObject({ status: 0, message: expect.stringContaining('timed out') })
  })

  it('treats a non-JSON success body as a retryable failure', async () => {
    const { horizon, sleeps } = client([new Response('<html>gateway</html>', { status: 200 }), json({ ok: 1 })])
    await expect(horizon.get('/')).resolves.toEqual({ ok: 1 })
    expect(sleeps).toHaveLength(1)
  })

  it('falls back to the status text when an error body is not a problem document', async () => {
    const { horizon } = client([new Response('nope', { status: 404, statusText: 'Not Found' })])
    await expect(horizon.get('/')).rejects.toMatchObject({ status: 404, problemType: null, extras: null, message: expect.stringContaining('Not Found') })
  })
})

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('12')).toBe(12_000)
    const now = Date.parse('2026-10-06T09:00:00Z')
    expect(parseRetryAfter('Tue, 06 Oct 2026 09:00:30 GMT', now)).toBe(30_000)
    expect(parseRetryAfter('Tue, 06 Oct 2026 08:00:00 GMT', now)).toBe(0)
  })

  it('ignores absent or unparseable values', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter(' ')).toBeNull()
    expect(parseRetryAfter('soon')).toBeNull()
  })
})
