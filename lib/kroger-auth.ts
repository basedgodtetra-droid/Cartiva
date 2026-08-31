import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { clearKrogerCartOperations } from "./kroger-cart-operations";
import { durableAtomicWriteFile, durableRemoveFile } from "./durable-files";
import "./server-only-guard";

const KROGER_API_ORIGIN = "https://api.kroger.com";
const TOKEN_PATH = "/v1/connect/oauth2/token";
const AUTHORIZE_PATH = "/v1/connect/oauth2/authorize";
// Customer authorization is used only for Cart API writes. Product discovery
// continues to use the server's client-credentials token, and Cartiva does not
// call Kroger's customer profile endpoints, so do not request broader consent.
export const KROGER_CUSTOMER_SCOPES = "cart.basic:write";
const PUBLIC_SCOPES = "product.compact";
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const OAUTH_START_LIMIT = 8;

interface KrogerTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
}

interface StoredCustomerSession {
  version: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  authorizationGeneration?: string;
}

interface EncryptedCustomerSession {
  version: 2 | 3;
  algorithm: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  authTag: string;
}

interface PendingAuthorization {
  expiresAt: number;
}

export interface KrogerAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionFile?: string;
  /** Domain-separates encrypted customer sessions for a temporary mobile owner. */
  sessionBinding?: string;
  /**
   * Mobile owners use this hook to enforce their inactivity window before
   * every cached or on-disk customer-session read. Returning false means the
   * durable session is definitively absent/expired; throwing fails closed.
   */
  beforeCustomerSessionAccess?: () => Promise<boolean>;
}

export class KrogerAuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | "configuration"
      | "oauth_state"
      | "oauth_binding"
      | "cart_history"
      | "rate_limit"
      | "not_connected"
      | "already_connected"
      | "storage"
      | "upstream",
    readonly status = 500,
  ) {
    super(message);
    this.name = "KrogerAuthError";
  }
}

function base64Url(value: Buffer) {
  return value.toString("base64url");
}

function configuredSessionFile() {
  return path.resolve(".cartiva", "kroger-session.json");
}

function cleanRequired(value: string | undefined, label: string) {
  const cleaned = value?.trim();
  if (!cleaned) {
    throw new KrogerAuthError(
      `Kroger is not configured. Add ${label} to the Cartiva server.`,
      "configuration",
      503,
    );
  }
  return cleaned;
}

function configFromEnvironment(): KrogerAuthConfig {
  const redirectUri = cleanRequired(process.env.KROGER_REDIRECT_URI, "KROGER_REDIRECT_URI");
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error("unsafe redirect");
    }
  } catch {
    throw new KrogerAuthError(
      "KROGER_REDIRECT_URI must be a valid HTTPS or local development URL.",
      "configuration",
      503,
    );
  }
  return {
    clientId: cleanRequired(process.env.KROGER_CLIENT_ID, "KROGER_CLIENT_ID"),
    clientSecret: cleanRequired(process.env.KROGER_CLIENT_SECRET, "KROGER_CLIENT_SECRET"),
    redirectUri,
  };
}

/**
 * Creates a request-scoped customer auth client for serverless web sessions.
 * The caller owns the supplied file and is responsible for removing it after
 * copying the encrypted session envelope into an HttpOnly cookie.
 */
export function createKrogerAuthClientForSessionFile(sessionFile: string) {
  return new KrogerAuthClient(
    { ...configFromEnvironment(), sessionFile },
    fetch,
    async () => undefined,
  );
}

function validTokenResponse(value: unknown): value is KrogerTokenResponse {
  if (!value || typeof value !== "object") return false;
  const token = value as Record<string, unknown>;
  return typeof token.access_token === "string"
    && token.access_token.length > 0
    && typeof token.expires_in === "number"
    && Number.isFinite(token.expires_in)
    && token.expires_in > 0;
}

function validStoredSession(value: unknown): value is StoredCustomerSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return session.version === 1
    && typeof session.accessToken === "string"
    && typeof session.refreshToken === "string"
    && typeof session.expiresAt === "number"
    && (
      session.authorizationGeneration === undefined
      || (
        typeof session.authorizationGeneration === "string"
        && /^[A-Za-z0-9_-]{43}$/.test(session.authorizationGeneration)
      )
    );
}

function validEncryptedSession(value: unknown): value is EncryptedCustomerSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  const keys = Object.keys(session);
  return keys.length === 5
    && keys.every((key) => ["version", "algorithm", "iv", "ciphertext", "authTag"].includes(key))
    && (session.version === 2 || session.version === 3)
    && session.algorithm === "aes-256-gcm"
    && typeof session.iv === "string"
    && /^[A-Za-z0-9_-]{16}$/.test(session.iv)
    && typeof session.ciphertext === "string"
    && /^[A-Za-z0-9_-]+$/.test(session.ciphertext)
    && typeof session.authTag === "string"
    && /^[A-Za-z0-9_-]{22}$/.test(session.authTag);
}

function isMissingSessionFile(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT",
  );
}

function customerSessionStorageError() {
  return new KrogerAuthError(
    "Cartiva could not verify the saved Kroger connection. Disconnect it explicitly or restore secure storage before reconnecting.",
    "storage",
    503,
  );
}

function sessionEncryptionKey(config: KrogerAuthConfig) {
  // Kroger client secrets are high-entropy server-only values. Domain-separate
  // the derived file key so the credential itself is never written to disk.
  return createHash("sha256")
    .update("Cartiva Kroger OAuth session encryption\0", "utf8")
    .update(config.clientId, "utf8")
    .update("\0", "utf8")
    .update(config.clientSecret, "utf8")
    .update("\0", "utf8")
    .update(config.sessionBinding ?? "legacy", "utf8")
    .digest();
}

function sessionAdditionalData(config: KrogerAuthConfig) {
  return Buffer.from(
    config.sessionBinding
      ? `cartiva:kroger-session:v3:${config.sessionBinding}`
      : "cartiva:kroger-session:v2",
    "utf8",
  );
}

function encryptCustomerSession(
  config: KrogerAuthConfig,
  session: StoredCustomerSession,
): EncryptedCustomerSession {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionEncryptionKey(config), iv);
  cipher.setAAD(sessionAdditionalData(config));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final(),
  ]);
  return {
    version: config.sessionBinding ? 3 : 2,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

function decryptCustomerSession(
  config: KrogerAuthConfig,
  envelope: EncryptedCustomerSession,
) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    sessionEncryptionKey(config),
    Buffer.from(envelope.iv, "base64url"),
  );
  if ((config.sessionBinding && envelope.version !== 3) || (!config.sessionBinding && envelope.version !== 2)) {
    throw new Error("Kroger session binding does not match.");
  }
  decipher.setAAD(sessionAdditionalData(config));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const parsed: unknown = JSON.parse(plaintext);
  if (!validStoredSession(parsed)) throw new Error("Invalid Kroger session payload.");
  return parsed;
}

/**
 * Server-only OAuth owner for Kroger. Neither client credentials nor customer
 * tokens are ever serialized into an API response consumed by the extension.
 */
export class KrogerAuthClient {
  private readonly sessionFile: string;
  private publicToken?: { accessToken: string; expiresAt: number };
  private publicTokenRequest?: Promise<string>;
  private customerSession?: StoredCustomerSession | null;
  private customerSessionLoad?: Promise<StoredCustomerSession | null>;
  private refreshRequest?: Promise<StoredCustomerSession>;
  private readonly pendingStates = new Map<string, PendingAuthorization>();
  private authorizationStarts: number[] = [];

  constructor(
    private readonly config: KrogerAuthConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly onCustomerChanged: () => Promise<void> = clearKrogerCartOperations,
  ) {
    this.sessionFile = config.sessionFile ?? configuredSessionFile();
  }

  private basicAuthorization() {
    return `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`;
  }

  private async requestToken(parameters: URLSearchParams) {
    let response: Response;
    try {
      response = await this.fetcher(`${KROGER_API_ORIGIN}${TOKEN_PATH}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: this.basicAuthorization(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: parameters,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      throw new KrogerAuthError(
        "Kroger authorization did not respond in time.",
        "upstream",
        502,
      );
    }
    if (!response.ok) {
      if (
        response.status === 400
        && parameters.get("grant_type") === "refresh_token"
      ) {
        let oauthError: unknown;
        try {
          oauthError = await response.json();
        } catch {
          oauthError = null;
        }
        if (
          oauthError
          && typeof oauthError === "object"
          && !Array.isArray(oauthError)
          && (oauthError as Record<string, unknown>).error === "invalid_grant"
        ) {
          // Kroger documents invalid_grant as a definitive rejected/expired
          // refresh grant. Never expose an accompanying provider description.
          throw new KrogerAuthError(
            "Your Kroger connection expired or was revoked. Connect Kroger again.",
            "not_connected",
            401,
          );
        }
      }
      throw new KrogerAuthError(
        "Kroger rejected the authorization request. Reconnect Kroger and try again.",
        "upstream",
        response.status === 401 || response.status === 403 ? 401 : 502,
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = null;
    }
    if (!validTokenResponse(value)) {
      throw new KrogerAuthError(
        "Kroger returned an invalid authorization response.",
        "upstream",
        502,
      );
    }
    return value;
  }

  async getPublicAccessToken() {
    if (this.publicToken && this.publicToken.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
      return this.publicToken.accessToken;
    }
    this.publicTokenRequest ??= (async () => {
      const token = await this.requestToken(new URLSearchParams({
        grant_type: "client_credentials",
        scope: PUBLIC_SCOPES,
      }));
      this.publicToken = {
        accessToken: token.access_token,
        expiresAt: Date.now() + token.expires_in * 1000,
      };
      return token.access_token;
    })().finally(() => {
      this.publicTokenRequest = undefined;
    });
    return this.publicTokenRequest;
  }

  private authorizationUrl(state: string, redirectUri: string) {
    const url = new URL(AUTHORIZE_PATH, KROGER_API_ORIGIN);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: KROGER_CUSTOMER_SCOPES,
      state,
    }).toString();
    return url.toString();
  }

  createAuthorizationUrl() {
    const now = Date.now();
    for (const [state, pending] of this.pendingStates) {
      if (pending.expiresAt <= now) this.pendingStates.delete(state);
    }
    this.authorizationStarts = this.authorizationStarts.filter(
      (startedAt) => startedAt + OAUTH_STATE_TTL_MS > now,
    );
    if (this.authorizationStarts.length >= OAUTH_START_LIMIT) {
      throw new KrogerAuthError(
        "Too many Kroger connection attempts. Wait a few minutes and try again.",
        "rate_limit",
        429,
      );
    }
    this.authorizationStarts.push(now);
    const state = base64Url(randomBytes(24));
    this.pendingStates.set(state, {
      expiresAt: now + OAUTH_STATE_TTL_MS,
    });
    return this.authorizationUrl(state, this.config.redirectUri);
  }

  /**
   * Used only when another server-side component owns durable, one-use state
   * validation (the temporary mobile-session OAuth state store).
   */
  createAuthorizationUrlAfterExternalStateRegistration(
    state: string,
    redirectUri = this.config.redirectUri,
  ) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)) {
      throw new KrogerAuthError("The Kroger authorization state is invalid.", "oauth_state", 400);
    }
    return this.authorizationUrl(state, redirectUri);
  }

  private async exchangeCode(code: string, redirectUri: string) {
    if (!code.trim()) {
      throw new KrogerAuthError("Kroger did not return an authorization code.", "oauth_state", 400);
    }
    const token = await this.requestToken(new URLSearchParams({
      grant_type: "authorization_code",
      code: code.trim(),
      redirect_uri: redirectUri,
    }));
    if (!token.refresh_token) {
      throw new KrogerAuthError(
        "Kroger did not return a reusable customer connection.",
        "upstream",
        502,
      );
    }
    if (token.scope) {
      const granted = new Set(token.scope.split(/\s+/).filter(Boolean));
      if (!granted.has("cart.basic:write")) {
        throw new KrogerAuthError(
          "Kroger did not grant permission to add products to the customer cart.",
          "upstream",
          403,
        );
      }
    }
    const session: StoredCustomerSession = {
      version: 1,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      scope: token.scope,
      authorizationGeneration: randomBytes(32).toString("base64url"),
    };
    try {
      await this.onCustomerChanged();
      await this.saveCustomerSession(session);
    } catch (error) {
      // Never leave an old customer token connected after its idempotency
      // transition was cleared or a replacement session failed to persist.
      await this.forgetCustomerSession().catch(() => undefined);
      throw error;
    }
    return session;
  }

  async exchangeAuthorizationCode(code: string, state: string) {
    const pending = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new KrogerAuthError(
        "This Kroger connection request expired or could not be verified. Start again.",
        "oauth_state",
        400,
      );
    }
    return this.exchangeCode(code, this.config.redirectUri);
  }

  /** Call only after consuming a valid state from a durable server-side store. */
  exchangeAuthorizationCodeAfterExternalStateValidation(
    code: string,
    redirectUri = this.config.redirectUri,
  ) {
    return this.exchangeCode(code, redirectUri);
  }

  private async loadCustomerSession() {
    if (this.config.beforeCustomerSessionAccess) {
      const available = await this.config.beforeCustomerSessionAccess();
      if (!available) {
        this.customerSession = null;
        return null;
      }
    }
    if (this.customerSession !== undefined) return this.customerSession;
    this.customerSessionLoad ??= (async () => {
      let serialized: string;
      try {
        serialized = await readFile(this.sessionFile, "utf8");
      } catch (error) {
        // Only a genuinely absent file means this owner has no saved account.
        // Permission, I/O, or path failures may hide an existing connection and
        // must not authorize a replacement session.
        if (isMissingSessionFile(error)) {
          this.customerSession = null;
          return null;
        }
        throw customerSessionStorageError();
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized);
      } catch {
        throw customerSessionStorageError();
      }
      try {
        if (validEncryptedSession(parsed)) {
          this.customerSession = decryptCustomerSession(this.config, parsed);
        } else if (validStoredSession(parsed) && !this.config.sessionBinding) {
          // One-time migration is deliberately limited to the legacy local
          // client. Owner-bound mobile sessions have only ever used v3.
          await this.saveCustomerSession(parsed);
        } else {
          // Malformed, legacy, cross-owner, and wrong-version records remain in
          // place as evidence of a storage problem. An explicit disconnect may
          // remove them; OAuth start/callback cannot silently replace them.
          throw customerSessionStorageError();
        }
      } catch (error) {
        if (error instanceof KrogerAuthError) throw error;
        throw customerSessionStorageError();
      }
      return this.customerSession ?? null;
    })().finally(() => {
      this.customerSessionLoad = undefined;
    });
    return this.customerSessionLoad;
  }

  private async saveCustomerSession(session: StoredCustomerSession) {
    const encrypted = encryptCustomerSession(this.config, session);
    try {
      await durableAtomicWriteFile(this.sessionFile, JSON.stringify(encrypted));
      this.customerSession = session;
    } catch {
      throw customerSessionStorageError();
    }
  }

  private async refreshCustomerSession(
    session: StoredCustomerSession,
    staleAccessToken?: string,
  ) {
    // Another request may already have rotated Kroger's single-use refresh
    // token. Reuse its result instead of spending the old token twice.
    const latest = await this.loadCustomerSession();
    if (staleAccessToken && latest && latest.accessToken !== staleAccessToken) return latest;
    this.refreshRequest ??= (async () => {
      const token = await this.requestToken(new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      }));
      if (!token.refresh_token) {
        throw new KrogerAuthError(
          "Kroger did not rotate the customer refresh token. Reconnect Kroger.",
          "upstream",
          401,
        );
      }
      const next: StoredCustomerSession = {
        version: 1,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
        scope: token.scope ?? session.scope,
        authorizationGeneration: session.authorizationGeneration,
      };
      await this.saveCustomerSession(next);
      return next;
    })().finally(() => {
      this.refreshRequest = undefined;
    });
    return this.refreshRequest;
  }

  async getCustomerAccessToken(forceRefresh = false, staleAccessToken?: string) {
    const session = await this.loadCustomerSession();
    if (!session) {
      throw new KrogerAuthError(
        "Connect your Kroger account before adding items to the cart.",
        "not_connected",
        401,
      );
    }
    if (forceRefresh || session.expiresAt - TOKEN_EXPIRY_SKEW_MS <= Date.now()) {
      try {
        return (await this.refreshCustomerSession(session, staleAccessToken)).accessToken;
      } catch (error) {
        if (error instanceof KrogerAuthError && error.status === 401) {
          await this.forgetCustomerSession();
          throw new KrogerAuthError(
            "Your Kroger connection expired or was revoked. Connect Kroger again.",
            "not_connected",
            401,
          );
        }
        throw error;
      }
    }
    return session.accessToken;
  }

  async getAuthorizationGeneration() {
    const session = await this.loadCustomerSession();
    if (!session) {
      throw new KrogerAuthError(
        "Connect your Kroger account before adding items to the cart.",
        "not_connected",
        401,
      );
    }
    if (session.authorizationGeneration) return session.authorizationGeneration;
    const migrated: StoredCustomerSession = {
      ...session,
      authorizationGeneration: randomBytes(32).toString("base64url"),
    };
    try {
      await this.saveCustomerSession(migrated);
      return migrated.authorizationGeneration!;
    } catch (error) {
      await this.forgetCustomerSession().catch(() => undefined);
      throw error;
    }
  }

  async fetchPublic(resource: string, init: RequestInit = {}) {
    const accessToken = await this.getPublicAccessToken();
    return this.fetcher(new URL(resource, KROGER_API_ORIGIN), {
      ...init,
      headers: {
        Accept: "application/json",
        ...init.headers,
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
      redirect: "error",
    });
  }

  async fetchCustomer(resource: string, init: RequestInit = {}) {
    const initialToken = await this.getCustomerAccessToken();
    const send = async (accessToken: string) => this.fetcher(
      new URL(resource, KROGER_API_ORIGIN),
      {
        ...init,
        headers: {
          Accept: "application/json",
          ...init.headers,
          Authorization: `Bearer ${accessToken}`,
        },
        cache: "no-store",
        redirect: "error",
      },
    );
    const first = await send(initialToken);
    if (first.status !== 401) return first;
    const refreshed = await this.getCustomerAccessToken(true, initialToken);
    const second = await send(refreshed);
    if (second.status === 401) await this.forgetCustomerSession();
    return second;
  }

  async connectionStatus() {
    const session = await this.loadCustomerSession();
    if (!session) return { connected: false as const };
    if (session.expiresAt - TOKEN_EXPIRY_SKEW_MS <= Date.now()) {
      try {
        await this.getCustomerAccessToken();
      } catch (error) {
        // getCustomerAccessToken converts only a definitive 401/403 refresh
        // rejection into not_connected, and does so only after deleting the
        // stored customer session. Network, upstream, and persistence errors
        // must propagate so an OAuth callback cannot replace an account merely
        // because Kroger or local storage was temporarily unavailable.
        if (
          error instanceof KrogerAuthError
          && error.code === "not_connected"
          && error.status === 401
        ) {
          return { connected: false as const };
        }
        throw error;
      }
    }
    return { connected: true as const };
  }

  async disconnect() {
    try {
      await this.onCustomerChanged();
    } finally {
      // Token deletion is the primary disconnect guarantee. A receipt-cleanup
      // failure must not leave the customer's Kroger refresh token connected.
      await this.forgetCustomerSession();
    }
  }

  private async forgetCustomerSession() {
    this.customerSession = null;
    try {
      await durableRemoveFile(this.sessionFile);
    } catch {
      throw customerSessionStorageError();
    }
  }
}

type KrogerGlobal = typeof globalThis & {
  __cartivaKrogerAuthClient?: KrogerAuthClient;
};

export function getKrogerAuthClient() {
  const globalState = globalThis as KrogerGlobal;
  globalState.__cartivaKrogerAuthClient ??= new KrogerAuthClient(configFromEnvironment());
  return globalState.__cartivaKrogerAuthClient;
}

export function resetKrogerAuthClientForTests() {
  delete (globalThis as KrogerGlobal).__cartivaKrogerAuthClient;
}

export function krogerAuthIsConfigured() {
  try {
    configFromEnvironment();
    return true;
  } catch {
    return false;
  }
}
