/**
 * The PostgreSQL schema, as ordered migrations.
 *
 * Amounts are `NUMERIC(40,0)` raw units plus a `decimals` column: never a
 * float, and wide enough for SEP-41 tokens beyond int64. The database repeats
 * the contract's hard constraints (uniqueness, positive amounts, closed sets
 * of values) as a backstop behind the shared rules in `nostro`.
 *
 * Append new migrations; never edit one that has shipped.
 */

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/

/** Quote a schema name after checking it is a plain identifier. */
export function quoteSchema(schema: string): string {
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`Invalid schema name ${JSON.stringify(schema)}: use lowercase letters, digits and _.`)
  }
  return `"${schema}"`
}

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')

const KINDS = list(['transfer', 'mint', 'burn', 'clawback', 'fee'])
const DIRECTIONS = list(['credit', 'debit'])
const DISPOSITIONS = list(['pending', 'allocated', 'partial', 'exception', 'ignored'])
const MEMO_TYPES = list(['text', 'id', 'hash', 'return'])
const EXPECTATION_STATUSES = list(['open', 'partially_paid', 'settled', 'cancelled'])
const EXCEPTION_STATUSES = list(['open', 'resolved', 'dismissed'])
const EXCEPTION_CODES = list([
  'UNMATCHED_NO_CANDIDATE',
  'AMBIGUOUS_MATCH',
  'WRONG_ASSET',
  'OVERPAYMENT',
  'DUPLICATE_PAYMENT',
  'PARTIAL_UNRESOLVED',
  'LATE_BEYOND_WINDOW',
  'MEMO_MISSING',
  'MEMO_MALFORMED',
  'MEMO_TRUNCATED',
  'UNEXPECTED_CREDIT',
  'UNEXPECTED_DEBIT',
  'REFUND_UNLINKED',
  'BALANCE_ATTESTATION_FAILED',
  'SOURCE_GAP_DETECTED',
  'ENRICHMENT_MISSING',
])

/** Each migration is a function of the quoted schema name. */
export const MIGRATIONS: readonly ((s: string) => string)[] = [
  (s) => `
    CREATE TABLE ${s}.movements (
      id             text PRIMARY KEY,
      seq            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      tenant_id      text NOT NULL,
      network        text NOT NULL,
      source         text NOT NULL,
      external_id    text NOT NULL,
      revision       integer NOT NULL CHECK (revision >= 1),
      account        text NOT NULL,
      direction      text NOT NULL CHECK (direction IN (${DIRECTIONS})),
      kind           text NOT NULL CHECK (kind IN (${KINDS})),
      asset          text NOT NULL,
      decimals       smallint NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount         numeric(40, 0) NOT NULL CHECK (amount > 0),
      counterparty   text,
      muxed_id       numeric(20, 0),
      memo_type      text CHECK (memo_type IN (${MEMO_TYPES})),
      -- id, hash and return memos; text memos go in memo_text because they
      -- can contain NUL, which a text column cannot hold.
      memo_value     text,
      memo_text      bytea,
      ledger         bigint NOT NULL CHECK (ledger >= 1),
      tx_hash        text,
      operation_id   text,
      occurred_at    timestamptz NOT NULL,
      enrichment     text NOT NULL CHECK (enrichment IN ('complete', 'missing')),
      disposition    text NOT NULL CHECK (disposition IN (${DISPOSITIONS})),
      ignored_reason text,
      created_at     timestamptz NOT NULL,
      CONSTRAINT movements_dedupe UNIQUE (tenant_id, network, source, external_id),
      CHECK ((disposition = 'ignored') = (ignored_reason IS NOT NULL))
    );
    CREATE INDEX movements_queue ON ${s}.movements (tenant_id, disposition, seq);
    CREATE INDEX movements_account ON ${s}.movements (tenant_id, account, seq);

    CREATE TABLE ${s}.expectations (
      id            text PRIMARY KEY,
      seq           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      tenant_id     text NOT NULL,
      reference     text NOT NULL,
      account       text NOT NULL,
      direction     text NOT NULL CHECK (direction IN (${DIRECTIONS})),
      asset         text NOT NULL,
      decimals      smallint NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount        numeric(40, 0) NOT NULL CHECK (amount > 0),
      muxed_id      numeric(20, 0),
      memo_type     text CHECK (memo_type IN (${MEMO_TYPES})),
      memo_value    text,
      memo_text     bytea,
      payers        text[] NOT NULL,
      due_at        timestamptz,
      expires_at    timestamptz,
      status        text NOT NULL CHECK (status IN (${EXPECTATION_STATUSES})),
      cancel_reason text,
      metadata      jsonb NOT NULL,
      created_at    timestamptz NOT NULL,
      updated_at    timestamptz NOT NULL,
      CONSTRAINT expectations_reference_unique UNIQUE (tenant_id, reference)
    );
    CREATE INDEX expectations_candidates ON ${s}.expectations (tenant_id, account, asset, status);
    CREATE INDEX expectations_muxed ON ${s}.expectations (tenant_id, muxed_id) WHERE muxed_id IS NOT NULL;

    CREATE TABLE ${s}.allocations (
      id             text PRIMARY KEY,
      seq            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      tenant_id      text NOT NULL,
      movement_id    text NOT NULL REFERENCES ${s}.movements (id),
      expectation_id text NOT NULL REFERENCES ${s}.expectations (id),
      asset          text NOT NULL,
      decimals       smallint NOT NULL,
      amount         numeric(40, 0) NOT NULL CHECK (amount > 0),
      strategy       text NOT NULL,
      score          double precision CHECK (score BETWEEN 0 AND 1),
      created_at     timestamptz NOT NULL,
      CONSTRAINT allocations_unique UNIQUE (movement_id, expectation_id)
    );
    CREATE INDEX allocations_expectation ON ${s}.allocations (expectation_id);

    CREATE TABLE ${s}.exceptions (
      id              text PRIMARY KEY,
      seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      tenant_id       text NOT NULL,
      code            text NOT NULL CHECK (code IN (${EXCEPTION_CODES})),
      status          text NOT NULL CHECK (status IN (${EXCEPTION_STATUSES})),
      movement_id     text REFERENCES ${s}.movements (id),
      expectation_id  text REFERENCES ${s}.expectations (id),
      account         text,
      asset           text,
      decimals        smallint,
      amount          numeric(40, 0),
      detail          text NOT NULL,
      -- json, not jsonb: evidence may quote memo text, and jsonb rejects \\u0000.
      evidence        json NOT NULL,
      opened_at       timestamptz NOT NULL,
      resolved_at     timestamptz,
      resolution_note text,
      CHECK (movement_id IS NOT NULL OR expectation_id IS NOT NULL OR account IS NOT NULL),
      CHECK ((amount IS NULL) = (asset IS NULL) AND (asset IS NULL) = (decimals IS NULL))
    );
    CREATE INDEX exceptions_queue ON ${s}.exceptions (tenant_id, status, code);
    CREATE INDEX exceptions_movement ON ${s}.exceptions (movement_id) WHERE movement_id IS NOT NULL;

    CREATE TABLE ${s}.cursors (
      tenant_id text NOT NULL,
      network   text NOT NULL,
      source    text NOT NULL,
      account   text NOT NULL,
      -- NULL until first set: the row exists so a transaction can lock it.
      value     text,
      PRIMARY KEY (tenant_id, network, source, account)
    );
  `,
]
