import { assertLoopbackBackend } from "./backend-client.js";

export const DEFAULT_BACKEND_URL = "http://127.0.0.1:8088";

const LEGACY_BACKEND_URLS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

export function restoredBackendBaseUrl(value: unknown) {
  if (typeof value !== "string") return DEFAULT_BACKEND_URL;
  try {
    const parsed = new URL(value.trim());
    assertLoopbackBackend(parsed.href);
    return LEGACY_BACKEND_URLS.has(parsed.origin)
      ? DEFAULT_BACKEND_URL
      : parsed.origin;
  } catch {
    return DEFAULT_BACKEND_URL;
  }
}
