const CHROME_EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;

const DEFAULT_LOCAL_DEVELOPMENT_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

interface ExtensionOriginOptions {
  nodeEnv?: string;
  productionExtensionId?: string;
  localDevelopmentOrigins?: string;
}

function validExtensionId(value: string | undefined) {
  const id = value?.trim() ?? "";
  return /^[a-p]{32}$/.test(id) ? id : undefined;
}

function configuredLocalOrigins(value: string | undefined) {
  if (!value?.trim()) return DEFAULT_LOCAL_DEVELOPMENT_ORIGINS;

  return new Set(
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => {
        try {
          const parsed = new URL(origin);
          return parsed.origin === origin
            && parsed.protocol === "http:"
            && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
        } catch {
          return false;
        }
      }),
  );
}

/**
 * Browser CORS boundary for the extension-specific API.
 *
 * Unpacked Chrome extensions receive an unpredictable ID, so development accepts
 * syntactically valid Chrome-extension origins only while no ID is configured.
 * As soon as CARTIVA_EXTENSION_ID is set, every environment requires that exact
 * extension. This keeps a locally running development server from exposing cart
 * mutation routes to unrelated installed extensions.
 */
export function isAllowedExtensionOrigin(
  origin: string | null,
  options: ExtensionOriginOptions = {},
) {
  if (!origin) return false;

  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const extensionMatch = origin.match(CHROME_EXTENSION_ORIGIN);
  if (extensionMatch) {
    const configuredId = options.productionExtensionId ?? process.env.CARTIVA_EXTENSION_ID;
    if (configuredId?.trim()) {
      const expectedId = validExtensionId(configuredId);
      return Boolean(expectedId && extensionMatch[1] === expectedId);
    }
    return nodeEnv !== "production";
  }

  if (nodeEnv === "production") return false;
  const localOrigins = configuredLocalOrigins(
    options.localDevelopmentOrigins ?? process.env.CARTIVA_EXTENSION_DEV_ORIGINS,
  );
  return localOrigins.has(origin);
}

export function extensionCorsHeaders(origin: string) {
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  });
}

export function withExtensionCors(response: Response, origin: string) {
  const headers = new Headers(response.headers);
  for (const [name, value] of extensionCorsHeaders(origin)) {
    if (name.toLowerCase() === "vary") {
      const current = headers.get("Vary");
      headers.set("Vary", current ? `${current}, Origin` : "Origin");
    } else {
      headers.set(name, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
