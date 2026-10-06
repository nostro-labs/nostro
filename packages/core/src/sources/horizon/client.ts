/**
 * A small Horizon HTTP client: paging, timeouts and retries, nothing else.
 *
 * It uses the platform `fetch` rather than `@stellar/stellar-sdk`'s server
 * class so that the paging and retry behaviour reconciliation depends on is
 * explicit and testable here, not inherited.
 *
 * Retries cover transport failures, timeouts, 429 and 5xx, with full-jitter
 * exponential backoff. `Retry-After` is honoured, but a server asking us to
 * wait longer than `maxRetryAfterMs` fails the call instead: `sync()` is
 * meant to be bounded, and sleeping for an hour inside a Lambda or a route
 * handler is worse than reporting the rate limit and resuming next run.
 */

export interface HorizonClientOptions {
  /** Base URL, e.g. `https://horizon-testnet.stellar.org`. A path prefix is preserved. */
  readonly url: string
  readonly fetch?: typeof globalThis.fetch
  /** Per-attempt timeout. Default 30s. */
  readonly timeoutMs?: number
  /** Retries after the first attempt. Default 4. */
  readonly retries?: number
  /** Backoff base and cap. Defaults 500ms and 30s. */
  readonly backoffBaseMs?: number
  readonly backoffMaxMs?: number
  /** Longest `Retry-After` we will sleep for before giving up. Default 60s. */
  readonly maxRetryAfterMs?: number
  readonly headers?: Readonly<Record<string, string>>
  /** Injected for tests. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
}

/** One page of a Horizon collection. */
export interface Page<T> {
  readonly records: readonly T[]
  /** The paging token of the last record, or `null` for an empty page. */
  readonly lastCursor: string | null
}

export type QueryValue = string | number | boolean | undefined

/** A Horizon `application/problem+json` error, or a transport failure. */
export class HorizonError extends Error {
  public readonly code = 'HORIZON'
  constructor(
    message: string,
    /** HTTP status, or 0 for a transport failure or timeout. */
    public readonly status: number,
    /** The problem `type` URL, e.g. `https://stellar.org/horizon-errors/not_found`. */
    public readonly problemType: string | null,
    public readonly extras: Readonly<Record<string, unknown>> | null,
    public readonly retryable: boolean,
    /** Milliseconds the server asked us to wait, when it said. */
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'HorizonError'
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/** Parse `Retry-After` as delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

export class HorizonClient {
  private readonly base: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly maxRetryAfterMs: number
  private readonly headers: Readonly<Record<string, string>>
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number

  constructor(options: HorizonClientOptions) {
    this.base = options.url.replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.retries = options.retries ?? 4
    this.backoffBaseMs = options.backoffBaseMs ?? 500
    this.backoffMaxMs = options.backoffMaxMs ?? 30_000
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000
    this.headers = { Accept: 'application/hal+json, application/problem+json', ...options.headers }
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.random = options.random ?? Math.random
  }

  url(path: string, query: Readonly<Record<string, QueryValue>> = {}): string {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v))
    const qs = params.toString()
    return `${this.base}${path.startsWith('/') ? path : `/${path}`}${qs === '' ? '' : `?${qs}`}`
  }

  /** GET a single resource. */
  async get<T>(path: string, query: Readonly<Record<string, QueryValue>> = {}): Promise<T> {
    return (await this.request(this.url(path, query))) as T
  }

  /** GET one page of a collection. */
  async page<T extends { paging_token: string }>(
    path: string,
    query: Readonly<Record<string, QueryValue>> = {},
  ): Promise<Page<T>> {
    const body = (await this.request(this.url(path, query))) as {
      _embedded?: { records?: T[] }
    }
    const records = body._embedded?.records
    if (!Array.isArray(records)) {
      throw new HorizonError(`Expected a collection from ${path}`, 200, null, null, false)
    }
    const last = records[records.length - 1]
    return { records, lastCursor: last === undefined ? null : last.paging_token }
  }

  private async request(url: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let error: HorizonError
      try {
        return await this.attempt(url)
      } catch (err) {
        if (!(err instanceof HorizonError)) throw err
        error = err
      }
      if (!error.retryable || attempt >= this.retries) throw error
      if (error.retryAfterMs !== null && error.retryAfterMs > this.maxRetryAfterMs) throw error
      const backoff = this.random() * Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** attempt)
      await this.sleep(Math.max(error.retryAfterMs ?? 0, backoff))
    }
  }

  private async attempt(url: string): Promise<unknown> {
    const controller = new AbortController()
    // The timeout spans the body read too: a server that sends headers and
    // then stalls must not hang the sync.
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const transport = (err: unknown): HorizonError => {
      const reason = controller.signal.aborted
        ? `timed out after ${this.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err)
      return new HorizonError(`GET ${url} failed: ${reason}`, 0, null, null, true)
    }
    try {
      let response: Response
      let text: string
      try {
        response = await this.fetchImpl(url, { headers: this.headers, signal: controller.signal })
        text = await response.text()
      } catch (err) {
        throw transport(err)
      }
      return this.interpret(url, response, text)
    } finally {
      clearTimeout(timer)
    }
  }

  private interpret(url: string, response: Response, text: string): unknown {
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    if (response.ok) {
      if (body === null) {
        throw new HorizonError(`GET ${url} returned a non-JSON body`, response.status, null, null, true)
      }
      return body
    }

    const problem = (body ?? {}) as { type?: unknown; title?: unknown; detail?: unknown; extras?: unknown }
    const title = typeof problem.title === 'string' ? problem.title : response.statusText
    const detail = typeof problem.detail === 'string' ? `: ${problem.detail}` : ''
    throw new HorizonError(
      `GET ${url} → ${response.status} ${title}${detail}`,
      response.status,
      typeof problem.type === 'string' ? problem.type : null,
      problem.extras !== null && typeof problem.extras === 'object'
        ? (problem.extras as Record<string, unknown>)
        : null,
      RETRYABLE_STATUS.has(response.status),
      parseRetryAfter(response.headers.get('retry-after')),
    )
  }
}
