import type { ConfigContext, ExpoConfig } from "expo/config";

const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "::1"
    || normalized === "0.0.0.0"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export interface PublicApiUrlValidationOptions {
  requireHttps: boolean;
}

/** Release builds must never silently bake the localhost runtime fallback in. */
export function validatePublicApiUrl(
  value: string | undefined,
  { requireHttps }: PublicApiUrlValidationOptions,
): string | undefined {
  const configured = value?.trim().replace(/\/+$/, "");

  if (!configured) {
    if (requireHttps) {
      throw new Error(
        "EXPO_PUBLIC_CARTIVA_API_URL is required for EAS builds and must be the deployed HTTPS Cartiva API origin.",
      );
    }
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("EXPO_PUBLIC_CARTIVA_API_URL must be a valid http(s) URL.");
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      "EXPO_PUBLIC_CARTIVA_API_URL must use http:// for local development or https:// for a deployed build.",
    );
  }
  if (requireHttps && parsed.protocol !== "https:") {
    throw new Error(
      "EAS builds require EXPO_PUBLIC_CARTIVA_API_URL to use https://. LAN http:// addresses are only for local Expo development.",
    );
  }
  if (requireHttps && isLoopbackHost(parsed.hostname)) {
    throw new Error(
      "EAS builds require EXPO_PUBLIC_CARTIVA_API_URL to use a reachable HTTPS Cartiva API host, not a loopback address.",
    );
  }
  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error(
      "EXPO_PUBLIC_CARTIVA_API_URL must be an origin only, without credentials, a path, a query, or a fragment.",
    );
  }

  return parsed.origin;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const requireHttps = process.env.CARTIVA_REQUIRE_HTTPS_API === "true"
    || Boolean(process.env.EAS_BUILD_PROFILE);

  validatePublicApiUrl(process.env.EXPO_PUBLIC_CARTIVA_API_URL, { requireHttps });

  return config as ExpoConfig;
};
