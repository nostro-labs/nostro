/**
 * Webhooks: the event log, POSTed to a URL, signed.
 *
 * `deliverWebhooks()` reads the tenant's events after the consumer's saved
 * position and POSTs them one at a time, in order. A 2xx moves the position
 * on; anything else stops the round there, so the next call retries the
 * same event and nothing is ever delivered out of order or skipped.
 * Delivery is at least once (a crash after the POST but before the position
 * is saved sends that event again), so receivers dedupe on the event id.
 *
 * Each request carries `Nostro-Signature: t=<unix seconds>,v1=<hex>`, the
 * HMAC-SHA256 of `<t>.<body>` under the shared secret. `verifyWebhook()`
 * checks it in constant time and refuses a timestamp outside the tolerance,
 * so a captured request cannot be replayed later.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Store } from '../store/index.js'
import { eventCursorKey, outboxEventJson } from '../store/index.js'

/** Shorter secrets can be guessed; generate them with `openssl rand -hex 32`. */
export const MIN_WEBHOOK_SECRET_LENGTH = 32

export const SIGNATURE_HEADER = 'nostro-signature'

const hmac = (secret: string, t: number, body: string) =>
  createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex')

/** The `Nostro-Signature` value for a body sent at `t` (unix seconds). */
export function signWebhook(secret: string, body: string, t: number): string {
  return `t=${t},v1=${hmac(secret, t, body)}`
}

export interface VerifyOptions {
  readonly secret: string
  /** The `Nostro-Signature` header as received. */
  readonly header: string | null | undefined
  /** The raw request body, exactly as received: verify before parsing. */
  readonly body: string
  /** How far `t` may be from now, in seconds. Default 300. */
  readonly toleranceSeconds?: number
  readonly now?: () => Date
}

/** True only for a body signed with `secret` within the tolerance. */
export function verifyWebhook(options: VerifyOptions): boolean {
  const { secret, header, body } = options
  if (typeof header !== 'string') return false
  const parts = new Map(header.split(',').map((p) => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()]))
  const t = parts.get('t')
  const v1 = parts.get('v1')
  if (t === undefined || v1 === undefined || !/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) return false
  const now = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000)
  if (Math.abs(now - Number(t)) > (options.toleranceSeconds ?? 300)) return false
  return timingSafeEqual(Buffer.from(hmac(secret, Number(t), body), 'hex'), Buffer.from(v1, 'hex'))
}

export interface DeliverOptions {
  readonly store: Store
  readonly tenantId: string
  readonly url: string
  readonly secret: string
  /** Names this destination's saved position. Default `webhook`. */
  readonly consumer?: string
  /** Events per call. Default 100. */
  readonly limit?: number
  /** Per request. Default 10 seconds. */
  readonly timeoutMs?: number
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => Date
}

export interface DeliverReport {
  readonly delivered: number
  /** The seq of the last event delivered, or the saved position if none was. */
  readonly position: number
  /** Why the round stopped early, if it did; the next call retries that event. */
  readonly failure: { readonly eventId: string; readonly reason: string } | null
  /** Another deliverer moved the position during this round; this one stopped. */
  readonly contended: boolean
}

/** Deliver the tenant's undelivered events, in order, until one fails or none are left. */
export async function deliverWebhooks(options: DeliverOptions): Promise<DeliverReport> {
  const { store, tenantId, url, secret } = options
  if (secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new Error(`A webhook secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters.`)
  }
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? (() => new Date())
  const key = eventCursorKey(tenantId, options.consumer ?? 'webhook')
  const saved = await store.getCursor(key)
  let position = saved === null ? 0 : Number(saved)
  let delivered = 0

  const events = await store.listEvents({ tenantId, afterSeq: position, limit: options.limit ?? 100 })
  for (const event of events) {
    const body = JSON.stringify(outboxEventJson(event))
    let reason: string | null = null
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'nostro-webhooks',
          'nostro-event-id': event.id,
          'nostro-event-type': event.type,
          [SIGNATURE_HEADER]: signWebhook(secret, body, Math.floor(now().getTime() / 1000)),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      })
      await response.body?.cancel()
      if (response.status < 200 || response.status >= 300) reason = `HTTP ${response.status}`
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
    if (reason !== null) return { delivered, position, failure: { eventId: event.id, reason }, contended: false }

    // Compare-and-set, as sync() does: stop if another deliverer got here first.
    const from = position
    const moved = await store.transaction(async (tx) => {
      const current = await tx.getCursor(key)
      if ((current === null ? 0 : Number(current)) !== from) return false
      await tx.setCursor(key, String(event.seq))
      return true
    })
    if (!moved) return { delivered, position, failure: null, contended: true }
    position = event.seq
    delivered += 1
  }
  return { delivered, position, failure: null, contended: false }
}
