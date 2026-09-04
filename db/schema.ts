export const krogerHandoffSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS kroger_comparisons (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    retailer TEXT NOT NULL CHECK (retailer = 'kroger'),
    response_encrypted TEXT NOT NULL,
    reviews_encrypted TEXT NOT NULL,
    selection_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kroger_comparisons_owner_expires
    ON kroger_comparisons (owner_id, expires_at)`,
  `CREATE TABLE IF NOT EXISTS kroger_oauth_states (
    state_hash TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    comparison_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    selection_version INTEGER NOT NULL,
    verifier_encrypted TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kroger_oauth_states_expires
    ON kroger_oauth_states (expires_at)`,
  `CREATE TABLE IF NOT EXISTS kroger_oauth_rate_limits (
    owner_id TEXT PRIMARY KEY,
    window_started_at INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS kroger_customer_sessions (
    owner_id TEXT PRIMARY KEY,
    session_encrypted TEXT NOT NULL,
    token_expires_at INTEGER NOT NULL,
    scope TEXT,
    session_version INTEGER NOT NULL DEFAULT 1,
    refresh_lock_token TEXT,
    refresh_locked_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS kroger_cart_operations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    comparison_id TEXT NOT NULL,
    selection_version INTEGER NOT NULL,
    request_fingerprint TEXT NOT NULL,
    payload_encrypted TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'ready', 'awaiting_auth', 'in_progress', 'outcome_unknown',
      'failed_retryable', 'succeeded'
    )),
    receipt_encrypted TEXT,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kroger_cart_operations_owner_expires
    ON kroger_cart_operations (owner_id, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_kroger_cart_operations_comparison
    ON kroger_cart_operations (owner_id, comparison_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_kroger_cart_operations_basket_version
    ON kroger_cart_operations (owner_id, comparison_id, selection_version)`,
] as const;
