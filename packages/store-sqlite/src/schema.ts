/**
 * The SQLite schema, as ordered migrations tracked in `PRAGMA user_version`.
 *
 * SQLite integers stop at 64 bits, so amounts are stored as decimal text and
 * constrained to positive integers without leading zeros; sums are taken in
 * application code as bigints. Text memos are BLOBs so NUL survives.
 *
 * Append new migrations; never edit one that has shipped.
 */

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
const appendOnly = (table: string) => `
    CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'the journal is append-only'); END;
    CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'the journal is append-only'); END;`
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

/** A positive integer in decimal text, no sign, no leading zero. */
const positive = (column: string) =>
  `CHECK (typeof(${column}) = 'text' AND ${column} GLOB '[1-9]*' AND ${column} NOT GLOB '*[^0-9]*')`

export const MIGRATIONS: readonly string[] = [
  `
    CREATE TABLE movements (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      id             TEXT NOT NULL UNIQUE,
      tenant_id      TEXT NOT NULL,
      network        TEXT NOT NULL,
      source         TEXT NOT NULL,
      external_id    TEXT NOT NULL,
      revision       INTEGER NOT NULL CHECK (revision >= 1),
      account        TEXT NOT NULL,
      direction      TEXT NOT NULL CHECK (direction IN (${DIRECTIONS})),
      kind           TEXT NOT NULL CHECK (kind IN (${KINDS})),
      asset          TEXT NOT NULL,
      decimals       INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount         TEXT NOT NULL ${positive('amount')},
      counterparty   TEXT,
      muxed_id       TEXT,
      memo_type      TEXT CHECK (memo_type IN (${MEMO_TYPES})),
      memo_value     TEXT,
      memo_text      BLOB,
      ledger         INTEGER NOT NULL CHECK (ledger >= 1),
      tx_hash        TEXT,
      operation_id   TEXT,
      occurred_at    INTEGER NOT NULL,
      enrichment     TEXT NOT NULL CHECK (enrichment IN ('complete', 'missing')),
      disposition    TEXT NOT NULL CHECK (disposition IN (${DISPOSITIONS})),
      ignored_reason TEXT,
      created_at     INTEGER NOT NULL,
      UNIQUE (tenant_id, network, source, external_id),
      CHECK ((disposition = 'ignored') = (ignored_reason IS NOT NULL))
    );
    CREATE INDEX movements_queue ON movements (tenant_id, disposition, seq);
    CREATE INDEX movements_account ON movements (tenant_id, account, seq);

    CREATE TABLE expectations (
      seq           INTEGER PRIMARY KEY AUTOINCREMENT,
      id            TEXT NOT NULL UNIQUE,
      tenant_id     TEXT NOT NULL,
      reference     TEXT NOT NULL,
      account       TEXT NOT NULL,
      direction     TEXT NOT NULL CHECK (direction IN (${DIRECTIONS})),
      asset         TEXT NOT NULL,
      decimals      INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount        TEXT NOT NULL ${positive('amount')},
      muxed_id      TEXT,
      memo_type     TEXT CHECK (memo_type IN (${MEMO_TYPES})),
      memo_value    TEXT,
      memo_text     BLOB,
      payers        TEXT NOT NULL,
      due_at        INTEGER,
      expires_at    INTEGER,
      status        TEXT NOT NULL CHECK (status IN (${EXPECTATION_STATUSES})),
      cancel_reason TEXT,
      metadata      TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      UNIQUE (tenant_id, reference)
    );
    CREATE INDEX expectations_candidates ON expectations (tenant_id, account, asset, status);
    CREATE INDEX expectations_muxed ON expectations (tenant_id, muxed_id) WHERE muxed_id IS NOT NULL;

    CREATE TABLE allocations (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      id             TEXT NOT NULL UNIQUE,
      tenant_id      TEXT NOT NULL,
      movement_id    TEXT NOT NULL REFERENCES movements (id),
      expectation_id TEXT NOT NULL REFERENCES expectations (id),
      asset          TEXT NOT NULL,
      decimals       INTEGER NOT NULL,
      amount         TEXT NOT NULL ${positive('amount')},
      strategy       TEXT NOT NULL,
      score          REAL CHECK (score BETWEEN 0 AND 1),
      created_at     INTEGER NOT NULL,
      UNIQUE (movement_id, expectation_id)
    );
    CREATE INDEX allocations_expectation ON allocations (expectation_id);

    CREATE TABLE exceptions (
      seq             INTEGER PRIMARY KEY AUTOINCREMENT,
      id              TEXT NOT NULL UNIQUE,
      tenant_id       TEXT NOT NULL,
      code            TEXT NOT NULL CHECK (code IN (${EXCEPTION_CODES})),
      status          TEXT NOT NULL CHECK (status IN (${EXCEPTION_STATUSES})),
      movement_id     TEXT REFERENCES movements (id),
      expectation_id  TEXT REFERENCES expectations (id),
      account         TEXT,
      asset           TEXT,
      decimals        INTEGER,
      amount          TEXT,
      detail          TEXT NOT NULL,
      evidence        TEXT NOT NULL,
      opened_at       INTEGER NOT NULL,
      resolved_at     INTEGER,
      resolution_note TEXT,
      CHECK (movement_id IS NOT NULL OR expectation_id IS NOT NULL OR account IS NOT NULL),
      CHECK ((amount IS NULL) = (asset IS NULL) AND (asset IS NULL) = (decimals IS NULL))
    );
    CREATE INDEX exceptions_queue ON exceptions (tenant_id, status, code);
    CREATE INDEX exceptions_movement ON exceptions (movement_id) WHERE movement_id IS NOT NULL;

    CREATE TABLE cursors (
      tenant_id TEXT NOT NULL,
      network   TEXT NOT NULL,
      source    TEXT NOT NULL,
      account   TEXT NOT NULL,
      value     TEXT NOT NULL,
      PRIMARY KEY (tenant_id, network, source, account)
    );
  `,
  // 2: the journal, append-only. Unlike PostgreSQL there is no balance
  // trigger: amounts are text beyond 64 bits and SQLite cannot sum them
  // exactly, so balance is enforced by the shared rule in code.
  `
    CREATE TABLE journal_entries (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      id           TEXT NOT NULL UNIQUE,
      tenant_id    TEXT NOT NULL,
      movement_id  TEXT REFERENCES movements (id),
      posting_no   INTEGER CHECK (posting_no >= 1),
      kind         TEXT NOT NULL CHECK (kind IN (${ENTRY_KINDS})),
      effective_at INTEGER NOT NULL,
      posted_at    INTEGER NOT NULL,
      description  TEXT NOT NULL,
      CHECK ((movement_id IS NULL) = (posting_no IS NULL)),
      UNIQUE (movement_id, posting_no)
    );
    CREATE INDEX journal_entries_effective ON journal_entries (tenant_id, effective_at);

    CREATE TABLE journal_lines (
      entry_id       TEXT NOT NULL REFERENCES journal_entries (id),
      line_no        INTEGER NOT NULL CHECK (line_no >= 1),
      tenant_id      TEXT NOT NULL,
      account        TEXT NOT NULL,
      role           TEXT NOT NULL CHECK (role IN (${LINE_ROLES})),
      side           TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
      asset          TEXT NOT NULL,
      decimals       INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount         TEXT NOT NULL ${positive('amount')},
      expectation_id TEXT REFERENCES expectations (id),
      exception_id   TEXT REFERENCES exceptions (id),
      PRIMARY KEY (entry_id, line_no)
    );
    CREATE INDEX journal_lines_account ON journal_lines (tenant_id, account, asset);
    ${appendOnly('journal_entries')}
    ${appendOnly('journal_lines')}
  `,
  // 3: look up a movement's entries without scanning the tenant's whole
  // journal. Without it SQLite answers through the (tenant_id, effective_at)
  // index, and posting a large backlog becomes quadratic.
  `
    CREATE INDEX journal_entries_movement ON journal_entries (tenant_id, movement_id, seq);
  `,
]
