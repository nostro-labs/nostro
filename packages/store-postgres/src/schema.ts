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
const LINE_ROLES = list([
  'cash',
  'issued',
  'receivable',
  'payable',
  'unapplied',
  'customer_credit',
  'unexplained',
  'network_fees',
  'uncategorized_income',
  'uncategorized_expense',
])
const ENTRY_KINDS = list(['initial', 'reclass', 'correction'])
const EVENT_TYPES = list([
  'movement.decided',
  'expectation.partially_paid',
  'expectation.settled',
  'expectation.cancelled',
  'exception.opened',
  'exception.resolved',
  'exception.dismissed',
])
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
  // 2: the journal. Append-only, and every entry balances per asset: the
  // database checks that at COMMIT, independently of application code.
  (s) => `
    CREATE TABLE ${s}.journal_entries (
      id           text PRIMARY KEY,
      seq          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      tenant_id    text NOT NULL,
      movement_id  text REFERENCES ${s}.movements (id),
      posting_no   integer CHECK (posting_no >= 1),
      kind         text NOT NULL CHECK (kind IN (${ENTRY_KINDS})),
      effective_at timestamptz NOT NULL,
      posted_at    timestamptz NOT NULL,
      description  text NOT NULL,
      CHECK ((movement_id IS NULL) = (posting_no IS NULL)),
      CONSTRAINT journal_posting_unique UNIQUE (movement_id, posting_no)
    );
    -- What accounting periods will filter and lock on.
    CREATE INDEX journal_entries_effective ON ${s}.journal_entries (tenant_id, effective_at);

    CREATE TABLE ${s}.journal_lines (
      entry_id       text NOT NULL REFERENCES ${s}.journal_entries (id),
      line_no        smallint NOT NULL CHECK (line_no >= 1),
      tenant_id      text NOT NULL,
      account        text NOT NULL,
      role           text NOT NULL CHECK (role IN (${LINE_ROLES})),
      side           text NOT NULL CHECK (side IN ('debit', 'credit')),
      asset          text NOT NULL,
      decimals       smallint NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount         numeric(40, 0) NOT NULL CHECK (amount > 0),
      expectation_id text REFERENCES ${s}.expectations (id),
      exception_id   text REFERENCES ${s}.exceptions (id),
      PRIMARY KEY (entry_id, line_no)
    );
    CREATE INDEX journal_lines_account ON ${s}.journal_lines (tenant_id, account, asset);

    CREATE FUNCTION ${s}.journal_check_entry(entry text) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF (SELECT count(*) FROM ${s}.journal_lines WHERE entry_id = entry) < 2 THEN
        RAISE EXCEPTION 'journal entry % has fewer than two lines', entry USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM ${s}.journal_lines WHERE entry_id = entry
        GROUP BY asset, decimals
        HAVING sum(CASE side WHEN 'debit' THEN amount ELSE -amount END) <> 0
      ) THEN
        RAISE EXCEPTION 'journal entry % does not balance', entry USING ERRCODE = 'check_violation';
      END IF;
    END $$;
    CREATE FUNCTION ${s}.journal_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM ${s}.journal_check_entry(NEW.id); RETURN NULL; END $$;
    CREATE FUNCTION ${s}.journal_line_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM ${s}.journal_check_entry(NEW.entry_id); RETURN NULL; END $$;
    CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON ${s}.journal_entries
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${s}.journal_entry_balanced();
    CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON ${s}.journal_lines
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${s}.journal_line_balanced();

    CREATE FUNCTION ${s}.journal_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'the journal is append-only' USING ERRCODE = 'check_violation'; END $$;
    CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON ${s}.journal_entries
      FOR EACH ROW EXECUTE FUNCTION ${s}.journal_append_only();
    CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON ${s}.journal_lines
      FOR EACH ROW EXECUTE FUNCTION ${s}.journal_append_only();
    CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON ${s}.journal_entries
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.journal_append_only();
    CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON ${s}.journal_lines
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.journal_append_only();
  `,
  // 3: the event log (outbox), written in the same transaction as each
  // decision. The payload is JSON kept as text: jsonb cannot hold the NUL a
  // text memo may carry. Writers take a per-tenant lock before inserting
  // (see PgTx.emit), so events commit in seq order and a consumer reading
  // after a seq can never skip one that commits late.
  (s) => `
    CREATE TABLE ${s}.events (
      seq        bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      id         text PRIMARY KEY,
      tenant_id  text NOT NULL,
      type       text NOT NULL CHECK (type IN (${EVENT_TYPES})),
      subject_id text NOT NULL,
      payload    text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE INDEX events_tenant ON ${s}.events (tenant_id, seq);
    CREATE FUNCTION ${s}.events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'the event log is append-only' USING ERRCODE = 'check_violation'; END $$;
    CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON ${s}.events
      FOR EACH ROW EXECUTE FUNCTION ${s}.events_append_only();
    CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON ${s}.events
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.events_append_only();
  `,
]
