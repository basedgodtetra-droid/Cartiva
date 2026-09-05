import { AsyncLocalStorage } from "node:async_hooks";
import { SESSION_LEASE_MS, STATE_TTL_MS, SharedStateError, validSharedCommand, type SharedCommand } from "./kroger-shared-protocol";
import "./server-only-guard";
import { executeKnowledgeCommand } from "./knowledge/sql";

export interface SharedStatement {
  bind(...values: (string | number | null)[]): SharedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
export interface SharedDatabase {
  prepare(sql: string): SharedStatement;
  batch(statements: SharedStatement[]): Promise<{ results?: Record<string, unknown>[]; meta?: { changes?: number } }[]>;
  withSession?(constraint: "first-primary"): SharedDatabase;
}
const databaseContext = new AsyncLocalStorage<SharedDatabase>();
export function withSharedDatabase<T>(db: SharedDatabase | undefined, work: () => T): T {
  return db ? databaseContext.run(db, work) : work();
}
export function currentSharedDatabase() { return databaseContext.getStore(); }

const SESSION_COLUMNS = "owner_id, session_encrypted, session_version, refresh_lock_token, refresh_locked_until";
const CART_COLUMNS = "request_fingerprint, status, payload_encrypted, receipt_encrypted, error_code";

/** Uses the existing Cartiva schema. No runtime DDL or historical-row migration. */
export async function executeSharedCommand(database: SharedDatabase, command: SharedCommand, now = Date.now()): Promise<unknown> {
  if (!validSharedCommand(command)) throw new SharedStateError("invalid", 400);
  const db = database.withSession?.("first-primary") ?? database;
  if (command.op === "knowledge.lookup" || command.op === "knowledge.learn" || command.op === "knowledge.correct" || command.op === "knowledge.seed") {
    return executeKnowledgeCommand(db, command, now);
  }
  const q = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).bind(...values);
  const c = command;
  switch (c.op) {
    case "session.ensure":
      await q(`INSERT INTO kroger_customer_sessions (owner_id,session_encrypted,token_expires_at,session_version,updated_at)
        VALUES (?, '', 0, 0, ?) ON CONFLICT(owner_id) DO NOTHING`, c.owner, now).run();
      return q(`SELECT ${SESSION_COLUMNS} FROM kroger_customer_sessions WHERE owner_id=?`, c.owner).first();
    case "session.read":
      return q(`SELECT ${SESSION_COLUMNS} FROM kroger_customer_sessions WHERE owner_id=?`, c.owner).first();
    case "session.acquire":
      // An abandoned lease may have spent a rotating refresh token. Fence its
      // result and require reconnect; never give that old token to a new worker.
      return q(`UPDATE kroger_customer_sessions SET
        session_encrypted=CASE WHEN refresh_lock_token IS NOT NULL THEN '' ELSE session_encrypted END,
        session_version=session_version + CASE WHEN refresh_lock_token IS NOT NULL THEN 1 ELSE 0 END,
        refresh_lock_token=?, refresh_locked_until=?, updated_at=?
        WHERE owner_id=? AND (refresh_lock_token IS NULL OR refresh_locked_until<=?)
        RETURNING ${SESSION_COLUMNS}`, c.lease, now + SESSION_LEASE_MS, now, c.owner, now).first();
    case "session.assert":
      return q(`SELECT ${SESSION_COLUMNS} FROM kroger_customer_sessions
        WHERE owner_id=? AND session_version=? AND refresh_lock_token=? AND refresh_locked_until>?`,
        c.owner, c.version, c.lease, now + 30_000).first();
    case "session.release":
      // Releasing our exact random lease cannot restore credentials. Allow it
      // after revocation changed the version, but never release a newer lease.
      return q(`UPDATE kroger_customer_sessions SET refresh_lock_token=NULL,refresh_locked_until=0
        WHERE owner_id=? AND refresh_lock_token=? AND refresh_locked_until>? RETURNING owner_id`, c.owner, c.lease, now).first();
    case "session.save":
      return q(`UPDATE kroger_customer_sessions SET session_encrypted=?,session_version=session_version+1,updated_at=?
        WHERE owner_id=? AND session_version=? AND refresh_lock_token=? AND refresh_locked_until>?
        RETURNING ${SESSION_COLUMNS}`, c.encrypted, now, c.owner, c.version, c.lease, now).first();
    case "session.revoke": {
      // Tombstone, never deletion: stale cookies/callbacks/refreshes cannot
      // initialize the owner again. In-flight transfer guards are untouched.
      const result = await db.batch([
        q(`UPDATE kroger_customer_sessions SET session_encrypted='',session_version=session_version+1,
          updated_at=? WHERE owner_id=? RETURNING owner_id`, now, c.owner),
        q(`UPDATE kroger_oauth_states SET consumed_at=? WHERE owner_id=? AND consumed_at IS NULL`, now, c.owner),
      ]);
      return Boolean(result[0]?.results?.length);
    }
    case "oauth.register":
      return q(`INSERT INTO kroger_oauth_states
        (state_hash,owner_id,comparison_id,operation_id,selection_version,verifier_encrypted,created_at,expires_at)
        SELECT ?,owner_id,'web2','web2',session_version,?,?,? FROM kroger_customer_sessions
        WHERE owner_id=? AND session_version=? AND refresh_lock_token=? AND refresh_locked_until>?
        RETURNING state_hash`, `web2:${c.hash}`, c.encrypted, now, now + STATE_TTL_MS, c.owner, c.version, c.lease, now).first();
    case "oauth.consume":
      return q(`UPDATE kroger_oauth_states SET consumed_at=? WHERE state_hash=? AND owner_id=?
        AND consumed_at IS NULL AND expires_at>?
        RETURNING owner_id,verifier_encrypted,selection_version,expires_at`, now, `web2:${c.hash}`, c.owner, now).first();
    case "oauth.peek":
      return q(`SELECT owner_id,verifier_encrypted,selection_version,expires_at FROM kroger_oauth_states
        WHERE state_hash=? AND consumed_at IS NULL AND expires_at>?`, `web2:${c.hash}`, now).first();
    case "cart.claim": {
      // First insertion and retry transition both require the current fenced
      // session. A random attempt token in error_code fences delayed RPCs.
      // Unknown outcomes have no TTL path back into write eligibility.
      const result = await db.batch([
        q(`INSERT INTO kroger_cart_operations
          (id,owner_id,comparison_id,selection_version,request_fingerprint,payload_encrypted,status,error_code,created_at,updated_at,expires_at)
          SELECT ?,owner_id,?,0,?,?,'outcome_unknown',?,?,?,253402300799000 FROM kroger_customer_sessions
          WHERE owner_id=? AND session_version=? AND refresh_lock_token=? AND refresh_locked_until>?
          AND NOT EXISTS (SELECT 1 FROM kroger_cart_operations WHERE owner_id=? AND status='outcome_unknown' AND (error_code IS NULL OR error_code NOT LIKE 'reviewed:%') AND id<>?)
          ON CONFLICT(id) DO NOTHING RETURNING id`, `web2:${c.id}`, c.id, c.fingerprint, c.payload,
          c.attempt, now, now, c.owner, c.version, c.lease, now, c.owner, `web2:${c.id}`),
        q(`UPDATE kroger_cart_operations SET status='outcome_unknown',error_code=?,payload_encrypted=?,updated_at=?
          WHERE id=? AND owner_id=? AND request_fingerprint=? AND status='failed_retryable'
          AND EXISTS (SELECT 1 FROM kroger_customer_sessions WHERE owner_id=? AND session_version=? AND refresh_lock_token=? AND refresh_locked_until>?)
          AND NOT EXISTS (SELECT 1 FROM kroger_cart_operations WHERE owner_id=? AND status='outcome_unknown' AND (error_code IS NULL OR error_code NOT LIKE 'reviewed:%') AND id<>?)
          RETURNING id`, c.attempt, c.payload, now, `web2:${c.id}`, c.owner, c.fingerprint,
          c.owner, c.version, c.lease, now, c.owner, `web2:${c.id}`),
      ]);
      return result.some(r => Boolean(r.results?.length));
    }
    case "cart.read":
      return q(`SELECT ${CART_COLUMNS} FROM kroger_cart_operations WHERE id=? AND owner_id=?`, `web2:${c.id}`, c.owner).first();
    case "cart.pending":
      return q(`SELECT ${CART_COLUMNS} FROM kroger_cart_operations WHERE owner_id=?
        AND status='outcome_unknown' AND (error_code IS NULL OR error_code NOT LIKE 'reviewed:%') ORDER BY created_at LIMIT 1`, c.owner).first();
    case "cart.acknowledge":
      // A response may have been lost before an operation row was created.
      // Insert a reviewed tombstone too, fencing a delayed original claim.
      return q(`INSERT INTO kroger_cart_operations
        (id,owner_id,comparison_id,selection_version,request_fingerprint,payload_encrypted,status,error_code,created_at,updated_at,expires_at)
        SELECT ?,owner_id,?,0,'','','outcome_unknown','reviewed:none',?,?,253402300799000 FROM kroger_customer_sessions
        WHERE owner_id=? AND (refresh_lock_token IS NULL OR refresh_locked_until<=?)
        ON CONFLICT(id) DO UPDATE SET status='outcome_unknown',error_code=CASE WHEN error_code LIKE 'reviewed:%'
          THEN error_code ELSE 'reviewed:' || COALESCE(error_code,'none') END,updated_at=excluded.updated_at
        WHERE owner_id=excluded.owner_id RETURNING id`, `web2:${c.id}`, c.id, now, now, c.owner, now - 30_000).first();
    case "cart.finish":
      return q(`UPDATE kroger_cart_operations SET status='succeeded',receipt_encrypted=?,updated_at=?
        WHERE id=? AND owner_id=? AND request_fingerprint=? AND status='outcome_unknown' AND error_code=?
        RETURNING id`, c.receipt, now, `web2:${c.id}`, c.owner, c.fingerprint, c.attempt).first();
    case "cart.retryable":
      return q(`UPDATE kroger_cart_operations SET status='failed_retryable',updated_at=?
        WHERE id=? AND owner_id=? AND request_fingerprint=? AND status='outcome_unknown' AND error_code=?
        RETURNING id`, now, `web2:${c.id}`, c.owner, c.fingerprint, c.attempt).first();
    case "rate": {
      const row = await q(`INSERT INTO kroger_oauth_rate_limits(owner_id,window_started_at,attempt_count) VALUES (?,?,1)
        ON CONFLICT(owner_id) DO UPDATE SET
        attempt_count=CASE WHEN window_started_at+?<=? THEN 1 ELSE MIN(attempt_count+1,1000000) END,
        window_started_at=CASE WHEN window_started_at+?<=? THEN ? ELSE window_started_at END
        RETURNING attempt_count`, `web2:rate:${c.key}`, now, c.windowMs, now, c.windowMs, now, now).first<{ attempt_count: number }>();
      return Boolean(row && row.attempt_count <= c.limit);
    }
  }
}

/** Persistent anti-replay check; only protocol-owned expired nonce rows prune. */
export async function consumeBridgeNonce(db: SharedDatabase, nonceHash: string, now = Date.now()) {
  const result = await db.batch([
    db.prepare(`DELETE FROM kroger_oauth_states WHERE state_hash LIKE 'rpc2:%' AND expires_at<?`).bind(now - 60_000),
    db.prepare(`INSERT INTO kroger_oauth_states
      (state_hash,owner_id,comparison_id,operation_id,selection_version,verifier_encrypted,created_at,expires_at,consumed_at)
      VALUES (?,'rpc2','rpc2','rpc2',0,'',?,?,?) ON CONFLICT(state_hash) DO NOTHING RETURNING state_hash`)
      .bind(`rpc2:${nonceHash}`, now, now + 120_000, now),
  ]);
  return Boolean(result[1]?.results?.length);
}
