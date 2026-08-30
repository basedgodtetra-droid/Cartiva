import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DELETE as revokeDelete,
  POST as createPost,
} from "@/app/api/mobile/v1/session/route";
import { POST as renewPost } from "@/app/api/mobile/v1/session/renew/route";
import { resetRateLimitsForTests } from "@/lib/api-security";
import {
  createMobileSessionCredentials,
  issueMobileSession,
  MOBILE_RECOVERY_INACTIVITY_MS,
  MOBILE_SESSION_TTL_MS,
  renewMobileSession,
  requireMobileSession,
  resetMobileSessionRecoveryForTests,
  verifyMobileSessionToken,
} from "@/lib/mobile-session";
import { resetMobileKrogerAuthForTests } from "@/lib/kroger-mobile-auth";
import {
  resetMobileOwnerOperationLocksForTests,
  withMobileOwnerOperationLock,
} from "@/lib/mobile-owner-operation-lock";

const initialNow = 1_800_000_000_000;
const ORIGINAL_SIGNING_SECRET = "renewal-session-secret-at-least-thirty-two-characters";
const ROTATED_SIGNING_SECRET = "rotated-renewal-secret-at-least-thirty-two-characters";
let directory: string;

function replacementToken(recoveryToken: string, fill: string) {
  const [, sessionId] = recoveryToken.split(".");
  return `r1.${sessionId}.${fill.repeat(43)}`;
}

function renewalRequest(recoveryToken: string, nextRecoveryToken: string) {
  return new Request("https://api.cartiva.test/api/mobile/v1/session/renew", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${recoveryToken}`,
      "Content-Type": "application/json",
      "X-Forwarded-For": "203.0.113.105",
    },
    body: JSON.stringify({ nextRecoveryToken }),
  });
}

function creationRequest() {
  return new Request("https://api.cartiva.test/api/mobile/v1/session", {
    method: "POST",
    headers: { "X-Forwarded-For": "203.0.113.106" },
  });
}

describe("durable rotating mobile session recovery", () => {
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-session-recovery-"));
    vi.stubEnv("CARTIVA_SESSION_SECRET", ORIGINAL_SIGNING_SECRET);
    vi.stubEnv("CARTIVA_MOBILE_SESSION_FILE", path.join(directory, "mobile-sessions.json"));
    vi.stubEnv("CARTIVA_MOBILE_OAUTH_STATE_DIR", path.join(directory, "oauth-states"));
    vi.stubEnv("CARTIVA_MOBILE_OAUTH_COMPLETION_DIR", path.join(directory, "oauth-completions"));
    vi.stubEnv("CARTIVA_MOBILE_KROGER_SESSION_DIR", path.join(directory, "kroger-sessions"));
    resetRateLimitsForTests();
    resetMobileSessionRecoveryForTests();
    resetMobileOwnerOperationLocksForTests();
    resetMobileKrogerAuthForTests();
  });

  afterEach(() => {
    resetRateLimitsForTests();
    resetMobileSessionRecoveryForTests();
    resetMobileOwnerOperationLocksForTests();
    resetMobileKrogerAuthForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("creates separate access and recovery credentials while persisting only a recovery hash", async () => {
    const response = await createPost(creationRequest());
    expect(response.status).toBe(201);
    const value = await response.json() as {
      sessionToken: string;
      recoveryToken: string;
      expiresAt: string;
    };

    expect(value.sessionToken).toMatch(/^v1\./);
    expect(value.recoveryToken).toMatch(/^r1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    const [, sessionId, recoverySecret] = value.recoveryToken.split(".");
    expect(value.sessionToken).toContain(`.${sessionId}.`);
    expect(verifyMobileSessionToken(value.sessionToken).ownerId).toMatch(/^[a-f0-9]{64}$/);

    const serialized = await readFile(path.join(directory, "mobile-sessions.json"), "utf8");
    expect(serialized).not.toContain(value.sessionToken);
    expect(serialized).not.toContain(value.recoveryToken);
    expect(serialized).not.toContain(recoverySecret);
    expect(JSON.parse(serialized)).toMatchObject({
      version: 1,
      records: [{
        version: 1,
        sessionId,
        currentRecoveryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        previousRecoveryHash: null,
      }],
    });
  });

  it("prunes abandoned recovery owners after thirty days of inactivity", async () => {
    expect(MOBILE_RECOVERY_INACTIVITY_MS).toBe(30 * 24 * 60 * 60_000);
    const abandoned = await createMobileSessionCredentials(initialNow);
    const later = initialNow + MOBILE_RECOVERY_INACTIVITY_MS + 1;
    await createMobileSessionCredentials(later);

    const stored = JSON.parse(
      await readFile(path.join(directory, "mobile-sessions.json"), "utf8"),
    ) as { records: { sessionId: string }[] };
    expect(stored.records).toHaveLength(1);
    expect(stored.records[0]?.sessionId).not.toBe(abandoned.recoveryToken.split(".")[1]);

    const next = replacementToken(abandoned.recoveryToken, "Z");
    await expect(renewMobileSession(
      renewalRequest(abandoned.recoveryToken, next),
      next,
      later,
    )).rejects.toMatchObject({ code: "invalid", status: 401 });
  });

  it("issues access for exactly one hour and rejects a validly signed farther-future bearer", async () => {
    const created = await createMobileSessionCredentials(initialNow);
    expect(created.expiresAt - initialNow).toBe(MOBILE_SESSION_TTL_MS);

    const fartherFuture = issueMobileSession(initialNow + MOBILE_SESSION_TTL_MS);
    expect(() => verifyMobileSessionToken(fartherFuture.sessionToken, initialNow))
      .toThrow(/invalid/i);
    expect(verifyMobileSessionToken(created.sessionToken, initialNow)).toEqual({
      ownerId: created.ownerId,
      expiresAt: initialNow + MOBILE_SESSION_TTL_MS,
    });
  });

  it("renews the same owner after access expiry only with the independent recovery credential", async () => {
    const created = await createMobileSessionCredentials(initialNow);
    const renewalNow = created.expiresAt + 1;
    const nextRecoveryToken = replacementToken(created.recoveryToken, "A");
    const renewed = await renewMobileSession(
      renewalRequest(created.recoveryToken, nextRecoveryToken),
      nextRecoveryToken,
      renewalNow,
    );

    expect(renewed.ownerId).toBe(created.ownerId);
    expect(renewed.recoveryToken).toBe(nextRecoveryToken);
    expect(verifyMobileSessionToken(renewed.sessionToken, renewalNow)).toEqual({
      ownerId: created.ownerId,
      expiresAt: renewed.expiresAt,
    });
  });

  it("never accepts an access bearer as a recovery credential", async () => {
    const created = await createMobileSessionCredentials(initialNow);
    const nextRecoveryToken = replacementToken(created.recoveryToken, "B");

    const response = await renewPost(renewalRequest(created.sessionToken, nextRecoveryToken));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "recovery_required" });
  });

  it("rotates current to next and permits only the exact lost-response retry", async () => {
    const created = await createMobileSessionCredentials(initialNow);
    const next = replacementToken(created.recoveryToken, "C");
    const request = () => renewalRequest(created.recoveryToken, next);

    const first = await renewMobileSession(request(), next, initialNow + 1);
    const retry = await renewMobileSession(request(), next, initialNow + 2);
    expect(first.ownerId).toBe(created.ownerId);
    expect(retry.ownerId).toBe(created.ownerId);

    const attackerProposal = replacementToken(created.recoveryToken, "D");
    await expect(renewMobileSession(
      renewalRequest(created.recoveryToken, attackerProposal),
      attackerProposal,
      initialNow + 3,
    )).rejects.toMatchObject({ code: "invalid", status: 401 });
    await expect(renewMobileSession(
      renewalRequest(next, replacementToken(next, "Q")),
      replacementToken(next, "Q"),
      initialNow + 4,
    )).rejects.toMatchObject({ code: "invalid", status: 401 });
  });

  it("rejects replay once a later successful rotation replaces the previous hash", async () => {
    const created = await createMobileSessionCredentials(initialNow);
    const second = replacementToken(created.recoveryToken, "E");
    const third = replacementToken(created.recoveryToken, "F");
    await renewMobileSession(renewalRequest(created.recoveryToken, second), second, initialNow + 1);
    await renewMobileSession(renewalRequest(second, third), third, initialNow + 2);

    await expect(renewMobileSession(
      renewalRequest(created.recoveryToken, second),
      second,
      initialNow + 3,
    )).rejects.toMatchObject({ code: "invalid", status: 401 });
  });

  it("isolates owners and rejects a replacement token for another session", async () => {
    const ownerA = await createMobileSessionCredentials(initialNow);
    const ownerB = await createMobileSessionCredentials(initialNow);

    await expect(renewMobileSession(
      renewalRequest(ownerA.recoveryToken, ownerB.recoveryToken),
      ownerB.recoveryToken,
      initialNow + 1,
    )).rejects.toMatchObject({ code: "invalid", status: 401 });
    expect(ownerA.ownerId).not.toBe(ownerB.ownerId);
  });

  it("serializes competing rotations so only one different replacement wins", async () => {
    const created = await createMobileSessionCredentials(initialNow);
    const nextA = replacementToken(created.recoveryToken, "G");
    const nextB = replacementToken(created.recoveryToken, "H");
    const attempts = await Promise.allSettled([
      renewMobileSession(renewalRequest(created.recoveryToken, nextA), nextA, initialNow + 1),
      renewMobileSession(renewalRequest(created.recoveryToken, nextB), nextB, initialNow + 1),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });

  it("uses the shared owner lock before rotating a recovery credential", async () => {
    const created = await createMobileSessionCredentials(initialNow);
    const next = replacementToken(created.recoveryToken, "M");
    let release!: () => void;
    let entered!: () => void;
    const enteredLock = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = withMobileOwnerOperationLock(created.ownerId, async () => {
      entered();
      await releaseLock;
    });
    await enteredLock;

    let renewalSettled = false;
    const renewal = renewMobileSession(
      renewalRequest(created.recoveryToken, next),
      next,
      initialNow + 1,
    ).then((value) => {
      renewalSettled = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(renewalSettled).toBe(false);

    release();
    await blocker;
    await expect(renewal).resolves.toMatchObject({ ownerId: created.ownerId });
  });

  it("globally serializes different owners so concurrent file mutations cannot lose records", async () => {
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) => (
      createMobileSessionCredentials(initialNow + index)
    )));
    const serialized = JSON.parse(
      await readFile(path.join(directory, "mobile-sessions.json"), "utf8"),
    ) as { records: Array<{ sessionId: string }> };
    expect(serialized.records).toHaveLength(created.length);
    expect(new Set(serialized.records.map((record) => record.sessionId)).size)
      .toBe(created.length);

    const ownerA = created[0];
    const ownerB = created[1];
    const nextA = replacementToken(ownerA.recoveryToken, "N");
    const nextB = replacementToken(ownerB.recoveryToken, "O");
    await Promise.all([
      renewMobileSession(renewalRequest(ownerA.recoveryToken, nextA), nextA, initialNow + 20),
      renewMobileSession(renewalRequest(ownerB.recoveryToken, nextB), nextB, initialNow + 20),
    ]);

    const laterA = replacementToken(ownerA.recoveryToken, "P");
    const laterB = replacementToken(ownerB.recoveryToken, "Q");
    await expect(Promise.all([
      renewMobileSession(renewalRequest(nextA, laterA), laterA, initialNow + 21),
      renewMobileSession(renewalRequest(nextB, laterB), laterB, initialNow + 21),
    ])).resolves.toHaveLength(2);
  });

  it("fails closed on corrupt durable recovery state without overwriting it", async () => {
    const created = await createMobileSessionCredentials(initialNow);
    const file = path.join(directory, "mobile-sessions.json");
    const corrupt = JSON.stringify({ version: 1, records: [{ sessionId: "attacker" }] });
    await writeFile(file, corrupt, "utf8");
    const next = replacementToken(created.recoveryToken, "I");

    await expect(renewMobileSession(
      renewalRequest(created.recoveryToken, next),
      next,
      initialNow + 1,
    )).rejects.toMatchObject({ code: "storage", status: 503 });
    expect(await readFile(file, "utf8")).toBe(corrupt);
  });

  it("uses the current signing key for access issued after server-key rotation", async () => {
    const created = await createMobileSessionCredentials(initialNow);
    vi.stubEnv("CARTIVA_SESSION_SECRET", ROTATED_SIGNING_SECRET);
    vi.stubEnv("CARTIVA_SESSION_PREVIOUS_SECRET", "");
    const next = replacementToken(created.recoveryToken, "J");
    const renewed = await renewMobileSession(
      renewalRequest(created.recoveryToken, next),
      next,
      initialNow + 1,
    );

    expect(renewed.ownerId).toBe(created.ownerId);
    expect(verifyMobileSessionToken(renewed.sessionToken, initialNow + 1).ownerId)
      .toBe(created.ownerId);
    expect(() => verifyMobileSessionToken(created.sessionToken, initialNow + 1)).toThrow(/invalid/i);
  });

  it("requires an exact renewal body and does not rotate on unknown fields", async () => {
    const created = await createMobileSessionCredentials(initialNow);
    const next = replacementToken(created.recoveryToken, "K");
    const response = await renewPost(new Request(
      "https://api.cartiva.test/api/mobile/v1/session/renew",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${created.recoveryToken}`,
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.105",
        },
        body: JSON.stringify({ nextRecoveryToken: next, ownerId: created.ownerId }),
      },
    ));
    expect(response.status).toBe(400);

    await expect(renewMobileSession(
      renewalRequest(created.recoveryToken, next),
      next,
      initialNow + 1,
    )).resolves.toMatchObject({ ownerId: created.ownerId });
  });

  it("rejects bodies on bodyless creation and revocation routes", async () => {
    const createResponse = await createPost(new Request(
      "https://api.cartiva.test/api/mobile/v1/session",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.108",
        },
        body: JSON.stringify({ ownerId: "attacker-selected-owner" }),
      },
    ));
    expect(createResponse.status).toBe(400);
    await expect(createResponse.json()).resolves.toEqual({
      error: "This Cartiva session request does not accept a body.",
      code: "invalid",
    });

    const created = await createMobileSessionCredentials(initialNow);
    const revokeResponse = await revokeDelete(new Request(
      "https://api.cartiva.test/api/mobile/v1/session",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${created.recoveryToken}`,
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.109",
        },
        body: JSON.stringify({ force: true }),
      },
    ));
    expect(revokeResponse.status).toBe(400);

    const next = replacementToken(created.recoveryToken, "R");
    await expect(renewMobileSession(
      renewalRequest(created.recoveryToken, next),
      next,
      initialNow + 1,
    )).resolves.toMatchObject({ ownerId: created.ownerId });
  });

  it("accepts Next's live-runtime empty stream for a bodyless creation request", async () => {
    const request = new Request("https://api.cartiva.test/api/mobile/v1/session", {
      method: "POST",
      headers: { "X-Forwarded-For": "203.0.113.110" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.body).not.toBeNull();
    const response = await createPost(request);
    expect(response.status).toBe(201);
  });

  it("maps an unusable recovery-store path to a controlled storage failure", async () => {
    const blockedParent = path.join(directory, "blocked-parent");
    await writeFile(blockedParent, "not a directory", "utf8");
    vi.stubEnv("CARTIVA_MOBILE_SESSION_FILE", path.join(blockedParent, "sessions.json"));

    const response = await createPost(creationRequest());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "storage" });
  });

  it("revokes the current recovery credential through DELETE without accepting it again", async () => {
    const created = await createMobileSessionCredentials(initialNow);
    const activeSessionFile = path.join(directory, "kroger-sessions", `${created.ownerId}.json`);
    await mkdir(path.dirname(activeSessionFile), { recursive: true });
    await writeFile(activeSessionFile, "encrypted-owner-token", { encoding: "utf8", flag: "wx" });
    const response = await revokeDelete(new Request(
      "https://api.cartiva.test/api/mobile/v1/session",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${created.recoveryToken}`,
          "X-Forwarded-For": "203.0.113.107",
        },
      },
    ));
    expect(response.status).toBe(204);
    await expect(readFile(activeSessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const idempotentRetry = await revokeDelete(new Request(
      "https://api.cartiva.test/api/mobile/v1/session",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${created.recoveryToken}`,
          "X-Forwarded-For": "203.0.113.107",
        },
      },
    ));
    expect(idempotentRetry.status).toBe(204);

    const next = replacementToken(created.recoveryToken, "L");
    await expect(renewMobileSession(
      renewalRequest(created.recoveryToken, next),
      next,
      initialNow + 1,
    )).rejects.toMatchObject({ code: "invalid", status: 401 });
    expect(JSON.parse(await readFile(path.join(directory, "mobile-sessions.json"), "utf8")))
      .toEqual({ version: 1, records: [] });
  });

  it("still requires access renewal before a protected operation starts near expiry", () => {
    const issued = issueMobileSession(Date.now() - MOBILE_SESSION_TTL_MS + 60_000);
    try {
      requireMobileSession(new Request("https://api.cartiva.test/protected", {
        headers: { Authorization: `Bearer ${issued.sessionToken}` },
      }));
      throw new Error("Expected renewal requirement");
    } catch (error) {
      expect(error).toMatchObject({ code: "renew_required", status: 401 });
    }
  });
});
