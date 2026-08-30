import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const SECURE_STORE_KEY = "cartiva.mobile.session.v1";
const SESSION_BOOTSTRAP_TIMEOUT_MS = 8_000;
const SESSION_SECURE_WAIT_TIMEOUT_MS = 10_000;
const ACCESS_TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]{43})\.([0-9a-z]{8,12})\.[A-Za-z0-9_-]{43}$/;
const RECOVERY_TOKEN_PATTERN = /^r1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;

interface MobileSessionCredentials {
  accessToken: string;
  recoveryToken?: string;
  /** Persisted before renewal so a lost response can replay the exact rotation. */
  pendingRecoveryToken?: string;
}

interface StoredMobileSessionCredentials {
  version: 2;
  accessToken: string;
  recoveryToken: string;
  pendingRecoveryToken?: string;
}

let memoryCredentials: MobileSessionCredentials | undefined;
let pendingBootstrap: Promise<MobileSessionCredentials> | undefined;
let pendingRenewal: { key: string; promise: Promise<MobileSessionCredentials> } | undefined;
let pendingStoredCredentials: Promise<MobileSessionCredentials | undefined> | undefined;
let secureStoreTail: Promise<void> = Promise.resolve();
let pendingClear: Promise<void> | undefined;
let sessionEpoch = 0;
let sessionResetInProgress = false;

function apiUrl(pathname: string) {
  const configured = process.env.EXPO_PUBLIC_CARTIVA_API_URL?.trim().replace(/\/+$/, "")
    || "http://127.0.0.1:3000";
  const origin = new URL(configured);
  if (!__DEV__ && origin.protocol !== "https:") {
    throw new Error("Production Cartiva builds require an HTTPS backend.");
  }
  return new URL(pathname, `${origin.toString().replace(/\/+$/, "")}/`).toString();
}

function accessSessionId(token: string) {
  return ACCESS_TOKEN_PATTERN.exec(token)?.[1];
}

function accessExpiresAt(token: string) {
  const encoded = ACCESS_TOKEN_PATTERN.exec(token)?.[2];
  if (!encoded) return undefined;
  const value = Number.parseInt(encoded, 36);
  return Number.isSafeInteger(value) ? value : undefined;
}

function recoverySessionId(token: string) {
  return RECOVERY_TOKEN_PATTERN.exec(token)?.[1];
}

function validCredentials(credentials: MobileSessionCredentials) {
  const sessionId = accessSessionId(credentials.accessToken);
  if (!sessionId) return false;
  if (credentials.recoveryToken && recoverySessionId(credentials.recoveryToken) !== sessionId) {
    return false;
  }
  if (
    credentials.pendingRecoveryToken
    && recoverySessionId(credentials.pendingRecoveryToken) !== sessionId
  ) return false;
  return !credentials.pendingRecoveryToken || Boolean(credentials.recoveryToken);
}

function damagedSessionError() {
  return new Error("The saved Cartiva session is damaged. Review any retailer cart, then reset the Cartiva session explicitly.");
}

function resetInProgressError() {
  return new Error("Cartiva is resetting this device’s temporary session. Wait for it to finish before trying again.");
}

function decodeStoredCredentials(value: string): MobileSessionCredentials {
  // A structurally valid legacy access bearer remains usable until expiry, but
  // it cannot be promoted into a recovery credential.
  if (accessSessionId(value)) return { accessToken: value };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw damagedSessionError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw damagedSessionError();
  }
  const record = parsed as Record<string, unknown>;
  const allowed = new Set(["version", "accessToken", "recoveryToken", "pendingRecoveryToken"]);
  if (
    Object.keys(record).some((key) => !allowed.has(key))
    || record.version !== 2
    || typeof record.accessToken !== "string"
    || typeof record.recoveryToken !== "string"
    || (record.pendingRecoveryToken !== undefined && typeof record.pendingRecoveryToken !== "string")
  ) throw damagedSessionError();
  const credentials: MobileSessionCredentials = {
    accessToken: record.accessToken,
    recoveryToken: record.recoveryToken,
    ...(typeof record.pendingRecoveryToken === "string"
      ? { pendingRecoveryToken: record.pendingRecoveryToken }
      : {}),
  };
  if (!validCredentials(credentials)) throw damagedSessionError();
  return credentials;
}

function encodeStoredCredentials(credentials: MobileSessionCredentials) {
  if (!credentials.recoveryToken || !validCredentials(credentials)) {
    throw new Error("Cartiva refused to save an invalid temporary session.");
  }
  const stored: StoredMobileSessionCredentials = {
    version: 2,
    accessToken: credentials.accessToken,
    recoveryToken: credentials.recoveryToken,
    ...(credentials.pendingRecoveryToken
      ? { pendingRecoveryToken: credentials.pendingRecoveryToken }
      : {}),
  };
  return JSON.stringify(stored);
}

function abortedRequestError() {
  const error = new Error("The Cartiva request was cancelled.");
  error.name = "AbortError";
  return error;
}

function waitForSharedValue<T>(
  value: Promise<T>,
  signal: AbortSignal | null | undefined,
  timeoutMessage: string,
) {
  if (signal?.aborted) return Promise.reject(abortedRequestError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(abortedRequestError()));
    const timeout = setTimeout(
      () => finish(() => reject(new Error(timeoutMessage))),
      SESSION_SECURE_WAIT_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", abort, { once: true });
    value.then(
      (resolved) => finish(() => resolve(resolved)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function enqueueSecureStoreMutation<T>(operation: () => Promise<T>) {
  const current = secureStoreTail.catch(() => undefined).then(operation);
  secureStoreTail = current.then(() => undefined, () => undefined);
  return current;
}

async function readStoredCredentials(epoch: number) {
  if (memoryCredentials) return memoryCredentials;
  if (Platform.OS === "web") return undefined;
  try {
    const value = await SecureStore.getItemAsync(SECURE_STORE_KEY);
    if (epoch !== sessionEpoch) throw abortedRequestError();
    if (!value) return undefined;
    const credentials = decodeStoredCredentials(value);
    if (epoch !== sessionEpoch) throw abortedRequestError();
    memoryCredentials = credentials;
    return credentials;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (error instanceof Error && /saved Cartiva session is damaged/i.test(error.message)) throw error;
    throw new Error("Cartiva could not access the secure temporary session on this device.");
  }
}

async function storedCredentials(signal?: AbortSignal | null) {
  if (pendingClear) {
    await waitForSharedValue(
      pendingClear,
      signal,
      "Cartiva timed out while finishing the requested session reset.",
    );
  }
  if (memoryCredentials) return memoryCredentials;
  if (!pendingStoredCredentials) {
    const epoch = sessionEpoch;
    const promise = readStoredCredentials(epoch).finally(() => {
      if (pendingStoredCredentials === promise) pendingStoredCredentials = undefined;
    });
    pendingStoredCredentials = promise;
  }
  return waitForSharedValue(
    pendingStoredCredentials,
    signal,
    "Cartiva timed out while reading the secure temporary session. The existing owner was kept; try again.",
  );
}

async function persistCredentials(credentials: MobileSessionCredentials, epoch: number) {
  const serialized = encodeStoredCredentials(credentials);
  await enqueueSecureStoreMutation(async () => {
    if (epoch !== sessionEpoch) throw abortedRequestError();
    if (Platform.OS !== "web") {
      await SecureStore.setItemAsync(SECURE_STORE_KEY, serialized, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    }
    // If reset began during the write, its queued delete wins on disk and this
    // stale task is forbidden from republishing memory.
    if (epoch !== sessionEpoch) throw abortedRequestError();
    memoryCredentials = credentials;
  });
}

/** Local deletion is explicit and serialized after every earlier write. */
export async function clearMobileSession() {
  const clearEpoch = ++sessionEpoch;
  memoryCredentials = undefined;
  pendingStoredCredentials = undefined;
  pendingBootstrap = undefined;
  pendingRenewal = undefined;
  const operation = enqueueSecureStoreMutation(async () => {
    if (Platform.OS !== "web") await SecureStore.deleteItemAsync(SECURE_STORE_KEY);
    if (sessionEpoch === clearEpoch) memoryCredentials = undefined;
  });
  const tracked = operation.finally(() => {
    if (pendingClear === tracked) pendingClear = undefined;
  });
  pendingClear = tracked;
  await tracked;
}

function responseCredentials(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  const allowed = new Set(["sessionToken", "recoveryToken", "expiresAt"]);
  if (
    Object.keys(response).some((key) => !allowed.has(key))
    || Object.keys(response).length !== allowed.size
    || typeof response.sessionToken !== "string"
    || typeof response.recoveryToken !== "string"
    || typeof response.expiresAt !== "string"
  ) {
    return null;
  }
  const embeddedExpiry = accessExpiresAt(response.sessionToken);
  const declaredExpiry = Date.parse(response.expiresAt);
  if (
    embeddedExpiry === undefined
    || !Number.isFinite(declaredExpiry)
    || declaredExpiry !== embeddedExpiry
    || new Date(declaredExpiry).toISOString() !== response.expiresAt
  ) return null;
  const credentials = {
    accessToken: response.sessionToken,
    recoveryToken: response.recoveryToken,
  };
  return validCredentials(credentials) ? credentials : null;
}

async function createMobileSession(epoch: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutError = new Error(
    "Cartiva timed out while starting a secure temporary session. Check your connection and try again.",
  );
  let rejectTimeout!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    rejectTimeout(timeoutError);
    controller.abort();
  }, SESSION_BOOTSTRAP_TIMEOUT_MS);
  const requestCredentials = async () => {
    const response = await fetch(apiUrl("api/mobile/v1/session"), {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "X-Cartiva-Client": "expo-mobile-v1",
      },
      signal: controller.signal,
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = null;
    }
    const credentials = responseCredentials(value);
    if (!response.ok || !credentials) {
      const error = value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).error
        : undefined;
      throw new Error(
        typeof error === "string"
          ? error
          : "Cartiva could not start a secure temporary session.",
      );
    }
    return credentials;
  };
  let credentials: MobileSessionCredentials;
  try {
    credentials = await Promise.race([requestCredentials(), deadline]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  await persistCredentials(credentials, epoch);
  return credentials;
}

function base64Url(bytes: Uint8Array) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += alphabet[(combined >>> 18) & 63];
    output += alphabet[(combined >>> 12) & 63];
    if (second !== undefined) output += alphabet[(combined >>> 6) & 63];
    if (third !== undefined) output += alphabet[combined & 63];
  }
  return output;
}

function nextRecoveryToken(current: string) {
  const sessionId = recoverySessionId(current);
  if (!sessionId) {
    throw new Error("This older Cartiva session cannot be renewed safely. Review any retailer cart, then reset the Cartiva session explicitly.");
  }
  return `r1.${sessionId}.${base64Url(Crypto.getRandomBytes(32))}`;
}

async function getMobileSessionCredentials(signal?: AbortSignal | null) {
  if (sessionResetInProgress) throw resetInProgressError();
  const existing = await storedCredentials(signal);
  if (sessionResetInProgress) throw resetInProgressError();
  if (existing) {
    // A pending rotation may already have reached the server. Reconcile that
    // exact rotation before sending another protected request.
    return existing.pendingRecoveryToken
      ? renewSameOwner(existing, signal)
      : existing;
  }
  if (!pendingBootstrap) {
    const epoch = sessionEpoch;
    const promise = createMobileSession(epoch).finally(() => {
      if (pendingBootstrap === promise) pendingBootstrap = undefined;
    });
    pendingBootstrap = promise;
  }
  return waitForSharedValue(
    pendingBootstrap,
    signal,
    "Cartiva timed out while securing the temporary session. The in-progress owner was kept; try again.",
  );
}

export async function getMobileSessionToken(signal?: AbortSignal | null) {
  return (await getMobileSessionCredentials(signal)).accessToken;
}

export async function getMobileSessionAuthorization(signal?: AbortSignal | null) {
  return { Authorization: `Bearer ${await getMobileSessionToken(signal)}` };
}

async function sessionCredentialRejection(response: Response) {
  if (response.status !== 401) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      response.clone().json() as Promise<{ code?: unknown }>,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), 2_000);
      }),
    ]);
    return value?.code === "missing"
      || value?.code === "invalid"
      || value?.code === "expired"
      || value?.code === "renew_required"
      ? value.code
      : null;
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function createSameOwnerRenewal(credentials: MobileSessionCredentials) {
  if (!credentials.recoveryToken) {
    throw new Error("This older Cartiva session cannot be renewed safely. Review any retailer cart, then reset the Cartiva session explicitly.");
  }
  const epoch = sessionEpoch;
  const proposedRecovery = credentials.pendingRecoveryToken
    ?? nextRecoveryToken(credentials.recoveryToken);
  if (!credentials.pendingRecoveryToken) {
    credentials = { ...credentials, pendingRecoveryToken: proposedRecovery };
    await persistCredentials(credentials, epoch);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeoutError = new Error(
    "Cartiva timed out while renewing the secure temporary session. Your existing owner was kept; try again.",
  );
  let rejectTimeout!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    rejectTimeout(timeoutError);
    controller.abort();
  }, SESSION_BOOTSTRAP_TIMEOUT_MS);
  const requestCredentials = async () => {
    const response = await fetch(apiUrl("api/mobile/v1/session/renew"), {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credentials.recoveryToken}`,
        "Content-Type": "application/json",
        "X-Cartiva-Client": "expo-mobile-v1",
      },
      body: JSON.stringify({ nextRecoveryToken: proposedRecovery }),
      signal: controller.signal,
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = null;
    }
    const renewed = responseCredentials(value);
    if (
      !response.ok
      || !renewed
      || renewed.recoveryToken !== proposedRecovery
      || accessSessionId(renewed.accessToken) !== accessSessionId(credentials.accessToken)
    ) {
      const error = value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).error
        : undefined;
      throw new Error(
        typeof error === "string"
          ? error
          : "Cartiva could not renew the secure temporary session. Your existing owner was kept.",
      );
    }
    return renewed;
  };
  let renewed: MobileSessionCredentials;
  try {
    renewed = await Promise.race([requestCredentials(), deadline]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  await persistCredentials(renewed, epoch);
  return renewed;
}

function renewSameOwner(
  credentials: MobileSessionCredentials,
  signal?: AbortSignal | null,
) {
  const key = `${credentials.recoveryToken ?? "legacy"}:${credentials.pendingRecoveryToken ?? "new"}`;
  if (!pendingRenewal || pendingRenewal.key !== key) {
    const promise = createSameOwnerRenewal(credentials).finally(() => {
      if (pendingRenewal?.promise === promise) pendingRenewal = undefined;
    });
    pendingRenewal = { key, promise };
  }
  return waitForSharedValue(
    pendingRenewal.promise,
    signal,
    "Cartiva timed out while securing the renewed session. The existing owner was kept; try again.",
  );
}

/**
 * Explicit destructive recovery for a broken anonymous owner. The caller must
 * warn the shopper to inspect any retailer cart first.
 */
export async function resetMobileSession() {
  if (sessionResetInProgress) throw resetInProgressError();
  sessionResetInProgress = true;
  try {
    let credentials: MobileSessionCredentials | undefined;
    let damagedLocalState = false;
    try {
      credentials = await storedCredentials();
    } catch (error) {
      if (error instanceof Error && /saved Cartiva session is damaged/i.test(error.message)) {
        damagedLocalState = true;
      } else {
        throw error;
      }
    }

    // A structurally damaged record exposes no valid recovery credential to
    // revoke. The shopper has already acknowledged the retailer-cart warning,
    // so preserve the explicit escape hatch while reporting it as local-only.
    if (damagedLocalState) {
      await clearMobileSession();
      return { serverRevoked: false };
    }

    // Keep the only durable revocation handle until the backend has definitely
    // confirmed that this owner can no longer recover. A timeout or malformed
    // response must leave SecureStore untouched so the shopper can retry.
    const recoveryCandidates = [
      credentials?.recoveryToken,
      credentials?.pendingRecoveryToken,
    ].filter((value): value is string => Boolean(value && recoverySessionId(value)));
    let serverRevoked = recoveryCandidates.length === 0;
    let lastFailure: unknown;
    const uniqueCandidates = [...new Set(recoveryCandidates)];
    for (const recoveryToken of uniqueCandidates) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch(apiUrl("api/mobile/v1/session"), {
          method: "DELETE",
          redirect: "error",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${recoveryToken}`,
            "X-Cartiva-Client": "expo-mobile-v1",
          },
          signal: controller.signal,
        });
        if (response.status === 204) {
          serverRevoked = true;
          break;
        }
        let value: unknown;
        try {
          value = await response.json();
        } catch {
          value = null;
        }
        const message = value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).error
          : undefined;
        lastFailure = new Error(
          typeof message === "string"
            ? message
            : "Cartiva could not confirm that the temporary session was revoked.",
        );
      } catch (error) {
        lastFailure = error;
      } finally {
        clearTimeout(timeout);
      }
    }
    if (!serverRevoked) {
      throw new Error(
        lastFailure instanceof Error && lastFailure.name !== "AbortError"
          ? `${lastFailure.message} The existing secure session was kept so you can retry safely.`
          : "Cartiva could not confirm the temporary-session reset. The existing secure session was kept so you can retry safely.",
      );
    }
    await clearMobileSession();
    return { serverRevoked };
  } finally {
    sessionResetInProgress = false;
  }
}

/**
 * Sends a bearer-authenticated request. An expired short access bearer is
 * renewed once with the separate recovery-only credential.
 */
export async function mobileSessionFetch(
  pathname: string,
  init: RequestInit,
) {
  const send = async (token: string) => fetch(apiUrl(pathname), {
    ...init,
    // Never forward anonymous owner credentials or mutation bodies through an
    // unexpected canonical/cross-origin redirect.
    redirect: "error",
    headers: {
      Accept: "application/json",
      "X-Cartiva-Client": "expo-mobile-v1",
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  const credentials = await getMobileSessionCredentials(init.signal);
  const first = await send(credentials.accessToken);
  const rejection = await sessionCredentialRejection(first);
  if (!rejection) return first;
  if (rejection === "expired" || rejection === "renew_required" || rejection === "invalid") {
    const renewed = await renewSameOwner(credentials, init.signal);
    return send(renewed.accessToken);
  }
  return first;
}
