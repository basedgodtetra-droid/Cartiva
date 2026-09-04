import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";

// Explicit, bounded integration probe. Uses NEW synthetic owners only; never
// reads customer rows or invokes a retailer API. Test guards remain fenced.
assert.equal(process.env.CARTIVA_SHARED_STATE_LIVE, "1", "Live shared-state probe requires explicit opt-in.");
const endpoint = new URL(process.env.CARTIVA_SHARED_STATE_URL);
const secret = process.env.CARTIVA_SHARED_STATE_SECRET;
const siteToken = process.env.CARTIVA_SHARED_STATE_SITE_TOKEN;
assert.equal(endpoint.protocol, "https:");
assert.equal(endpoint.pathname, "/api/internal/kroger-state");
assert(secret?.length >= 43 && siteToken);
const token = () => randomBytes(32).toString("base64url");
const hash = value => createHash("sha256").update(value).digest("hex");
let calls = 0;
async function rpc(command) {
  const body = JSON.stringify(command), timestamp = String(Date.now()), nonce = token();
  const signature = createHmac("sha256", secret).update(`POST\n${endpoint.pathname}\n${timestamp}\n${nonce}\n${body}`).digest("base64url");
  calls += 1;
  const response = await fetch(endpoint, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json", "OAI-Sites-Authorization": `Bearer ${siteToken}`,
      "X-Cartiva-State-Time": timestamp, "X-Cartiva-State-Nonce": nonce, "X-Cartiva-State-Signature": signature }, body,
  });
  assert.equal(response.status, 200, `Shared command ${command.op} rejected with status ${response.status}`);
  const value = await response.json(); assert(Object.hasOwn(value, "result")); return value.result;
}
const owner = `web2:${randomBytes(32).toString("hex")}`, other = `web2:${randomBytes(32).toString("hex")}`;
const checks = [];
await rpc({ op: "session.ensure", owner });
const leases = Array.from({ length: 4 }, token);
const contenders = await Promise.all(leases.map(lease => rpc({ op: "session.acquire", owner, lease })));
assert.equal(contenders.filter(Boolean).length, 1);
const lease = contenders.find(Boolean).refresh_lock_token;
checks.push("four independent requests have exactly one lease winner");
const state = hash(token());
await rpc({ op: "oauth.register", owner, lease, version: 0, hash: state, encrypted: "synthetic-non-customer-state" });
assert.equal((await Promise.all([1, 2].map(() => rpc({ op: "oauth.consume", owner, hash: state })))).filter(Boolean).length, 1);
checks.push("OAuth state is consumed once across concurrent requests");
const id = hash(token()), fingerprint = token(), attempt = token();
const claim = { op: "cart.claim", owner, lease, version: 0, id, fingerprint, attempt, payload: "synthetic-no-retailer-write" };
assert.equal((await Promise.all([1, 2].map(() => rpc(claim)))).filter(Boolean).length, 1);
assert.equal(await rpc({ ...claim, id: hash(token()), attempt: token() }), false);
assert.equal(await rpc({ op: "cart.read", owner: other, id }), null);
checks.push("one cart claim wins; unresolved owner guard and cross-owner isolation hold");
await rpc({ op: "session.revoke", owner });
assert.equal(await rpc({ op: "session.assert", owner, lease, version: 0 }), null);
assert.equal(await rpc({ op: "cart.acknowledge", owner, id }), null);
await rpc({ op: "session.release", owner, lease, version: 0 });
assert(await rpc({ op: "cart.acknowledge", owner, id }));
assert.equal(await rpc({ op: "cart.finish", owner, id, fingerprint, attempt, receipt: "late-test-result" }), null);
assert.equal(await rpc({ op: "cart.retryable", owner, id, fingerprint, attempt }), null);
checks.push("disconnect fences credentials, keeps live transfer barrier, and review fences delayed terminal writes");
const row = await rpc({ op: "session.read", owner });
assert.equal(row.session_encrypted, ""); assert.equal(row.session_version, 1);
const quota = hash(token());
assert.equal((await Promise.all(Array.from({ length: 8 }, () => rpc({ op: "rate", key: quota, limit: 3, windowMs: 60_000 })))).filter(Boolean).length, 3);
checks.push("durable quota allows exactly three of eight concurrent requests");
console.log(JSON.stringify({ passed: checks.length, checks, bridgeRequests: calls, retailerRequests: 0, syntheticOwnersCreated: 1 }, null, 2));
