import path from "node:path";
import "./server-only-guard";

export type MobileSecureStateStatus =
  | { configured: true; mode: "DEVELOPMENT_SINGLE_PROCESS" | "SINGLE_INSTANCE_FILESYSTEM" }
  | { configured: false; reason: string };

const PRODUCTION_STATE_PATHS = [
  "CARTIVA_MOBILE_SESSION_FILE",
  "CARTIVA_MOBILE_OAUTH_STATE_DIR",
  "CARTIVA_MOBILE_OAUTH_COMPLETION_DIR",
  "CARTIVA_MOBILE_KROGER_SESSION_DIR",
  "CARTIVA_COMPARISON_RECEIPT_FILE",
  "KROGER_CART_RECEIPT_FILE",
] as const;

function clean(value: string | undefined) {
  return value?.trim() ?? "";
}

/**
 * Local JSON state is safe only in one Node process on one durable volume.
 * Production capability detection fails closed unless that topology is an
 * explicit deployment decision; horizontally scaled/serverless deployments
 * must use a transactional shared store before adding another mode here.
 */
export function mobileSecureStateStatus(): MobileSecureStateStatus {
  if (clean(process.env.CARTIVA_ENABLE_KROGER_CART_WRITES).toLowerCase() !== "true") {
    return {
      configured: false,
      reason: "Kroger cart writing is not explicitly enabled on this Cartiva backend.",
    };
  }
  if (process.env.NODE_ENV !== "production") {
    return { configured: true, mode: "DEVELOPMENT_SINGLE_PROCESS" };
  }
  if (clean(process.env.CARTIVA_SECURE_STATE_MODE) !== "SINGLE_INSTANCE_FILESYSTEM") {
    return {
      configured: false,
      reason: "Production cart writing needs a reviewed durable secure-state deployment.",
    };
  }
  if (clean(process.env.CARTIVA_TRUSTED_EDGE).toLowerCase() !== "true") {
    return {
      configured: false,
      reason: "Production cart writing needs a trusted rate-limiting edge with the backend origin restricted from direct public access.",
    };
  }
  const missingOrRelative = PRODUCTION_STATE_PATHS.filter((name) => {
    const value = clean(process.env[name]);
    return !value || !path.isAbsolute(value);
  });
  if (missingOrRelative.length) {
    return {
      configured: false,
      reason: "Production cart writing needs absolute paths on one persistent server volume.",
    };
  }
  if (process.platform === "win32") {
    return {
      configured: false,
      reason: "Production Kroger cart writing requires a filesystem/runtime that can durably sync atomic rename metadata.",
    };
  }
  return { configured: true, mode: "SINGLE_INSTANCE_FILESYSTEM" };
}

export function requireMobileSecureState() {
  const status = mobileSecureStateStatus();
  if (!status.configured) throw new Error(status.reason);
  return status;
}
