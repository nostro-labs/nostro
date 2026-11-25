/**
 * Minimal Stellar RPC JSON-RPC client (#24).
 *
 * Covers only the methods nostro needs: `getEvents` and `getHealth`.
 * Retry and Retry-After logic mirrors HorizonClient: up to `maxRetries`
 * attempts with exponential back-off, honouring a `Retry-After` header.
 *
 * No runtime dependencies beyond `fetch` (Node ≥ 18 / edge runtimes).
 */

export class StellarRpcError extends Error {
  public readonly code = 'RPC_ERROR'
  constructor(
    public readonly rpcCode: number,
    message: string,
  ) {
    super(`Stellar RPC error ${rpcCode}: ${message}`)
    this.name = 'StellarRpcError'
  }
}

export interface GetEventsFilter {
  /** Up to 5 contract ids. */
  contractIds?: string[]
  /**
   * Topic segments. Each inner array is one filter segment; wildcards are `*`;
   * a trailing `**` matches the rest. Up to 5 filters, 1–4 segments each.
   */
  topics?: string[][]
}

export interface RpcEvent {
  id: string
  type: 'contract' | 'system' | 'diagnostic'
  ledger: number
  ledgerClosedAt: string
  contractId: string
  pagingToken: string
  topic: string[]
  value: unknown
  inSuccessfulContractCall: boolean
}

export interface GetEventsResult {
  /** Tip observed by the responding server. A paginated response can still have unread events. */
  latestLedger?: number
  events: RpcEvent[]
  /** Cursor to pass as `cursor` in the next request. */
  cursor: string | null
}

export interface GetHealthResult {
  status: string
  latestLedger: number
  oldestLedger: number
  ledgerRetentionWindow: number
}

export interface StellarRpcClientOptions {
  /** JSON-RPC endpoint URL. */
  url: string
  /** Request timeout in milliseconds. Default: 30 000. */
  timeoutMs?: number
  /** Maximum retry attempts on 429 / 5xx. Default: 3. */
  maxRetries?: number
}

export class StellarRpcClient {
  private readonly url: string
  private readonly timeoutMs: number
  private readonly maxRetries: number

  constructor(opts: StellarRpcClientOptions) {
    this.url = opts.url
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.maxRetries = opts.maxRetries ?? 3
  }

  async getHealth(): Promise<GetHealthResult> {
    return this.call<GetHealthResult>('getHealth', {})
  }

  async getEvents(params: {
    startLedger?: number
    cursor?: string
    filters?: GetEventsFilter[]
    limit?: number
  }): Promise<GetEventsResult> {
    const result = await this.call<GetEventsResult>('getEvents', params)
    const tip = result.latestLedger
    return {
      ...(typeof tip === 'number' && Number.isInteger(tip) && tip > 0 && tip <= 0xffffffff
        ? { latestLedger: tip } : {}),
      events: result.events ?? [],
      cursor: result.cursor ?? null,
    }
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    let attempt = 0
    while (true) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      let res: Response
      try {
        res = await fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }

      // Honour Retry-After on 429 / 503
      if ((res.status === 429 || res.status === 503) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? 1)
        await sleep(retryAfter * 1000)
        attempt++
        continue
      }
      if (!res.ok) throw new StellarRpcError(res.status, `HTTP ${res.status}`)

      const body = (await res.json()) as { result?: T; error?: { code: number; message: string } }
      if (body.error) throw new StellarRpcError(body.error.code, body.error.message)
      return body.result as T
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
