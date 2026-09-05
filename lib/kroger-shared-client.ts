import { randomBytes } from "node:crypto";
import { fetchBufferedResponse } from "./browser-request";
import { bridgeSignature, SHARED_PATH, SharedStateError, validSharedCommand, type SharedCommand } from "./kroger-shared-protocol";
import { currentSharedDatabase, executeSharedCommand } from "./kroger-shared-sql";
import "./server-only-guard";

export function sharedWebSessionEnabled() {
  return ["d1", "bridge"].includes(process.env.CARTIVA_SHARED_STATE_MODE ?? "")
    || (process.env.NODE_ENV === "production"
      && (process.env.VERCEL === "1" || process.env.CARTIVA_SERVERLESS_WEB_SESSION === "true"));
}
export function sharedWebSessionConfigured() {
  if ((process.env.CARTIVA_SHARED_STATE_SECRET?.length ?? 0) < 43) return false;
  if (process.env.CARTIVA_SHARED_STATE_MODE === "d1") return true;
  return process.env.CARTIVA_SHARED_STATE_MODE === "bridge"
    && Boolean(process.env.CARTIVA_SHARED_STATE_URL && process.env.CARTIVA_SHARED_STATE_SITE_TOKEN);
}

export async function sharedCommand<T>(command: SharedCommand): Promise<T> {
  if (!validSharedCommand(command) || !sharedWebSessionConfigured()) throw new SharedStateError("unavailable");
  try {
    if (process.env.CARTIVA_SHARED_STATE_MODE === "d1") {
      const db = currentSharedDatabase();
      if (!db) throw new SharedStateError("unavailable");
      return await executeSharedCommand(db, command) as T;
    }
    const endpoint = new URL(process.env.CARTIVA_SHARED_STATE_URL!);
    // The destination is server configuration, never a browser-supplied URL.
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password
      || endpoint.pathname !== SHARED_PATH || endpoint.search || endpoint.hash) throw new SharedStateError("unavailable");
    const body = JSON.stringify(command);
    const timestamp = String(Date.now());
    const nonce = randomBytes(32).toString("base64url");
    const response = await fetchBufferedResponse(endpoint.toString(), {
      method: "POST", cache: "no-store", redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "OAI-Sites-Authorization": `Bearer ${process.env.CARTIVA_SHARED_STATE_SITE_TOKEN}`,
        "X-Cartiva-State-Time": timestamp, "X-Cartiva-State-Nonce": nonce,
        "X-Cartiva-State-Signature": bridgeSignature(body, timestamp, nonce),
      }, body,
    }, command.op.startsWith("knowledge.") ? 4_000 : 12_000);
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new SharedStateError("unavailable");
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("result" in value)) throw new SharedStateError("unavailable");
    return value.result as T;
  } catch (error) {
    if (error instanceof SharedStateError) throw error;
    // Never log/enclose a command, encrypted session, bridge URL or secret.
    throw new SharedStateError("unavailable");
  }
}
