import { enforcePublicReadRateLimit } from "@/lib/api-security";
import {
  mobileSessionOptions,
  rejectDisallowedMobileBrowserOrigin,
  withMobileReadCors,
  withMobileSessionCors,
} from "@/lib/mobile-api-cors";
import {
  createMobileSessionCredentials,
  mobileSessionErrorResponse,
  revokeMobileSessionRecovery,
} from "@/lib/mobile-session";
import { disconnectMobileKrogerOwnerStateUnlocked } from "@/lib/kroger-mobile-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const BODYLESS_READ_TIMEOUT_MS = 8_000;

export function OPTIONS(request: Request) {
  return mobileSessionOptions(request, ["POST", "DELETE"]);
}

async function rejectUnexpectedBody(request: Request) {
  const contentLength = request.headers.get("Content-Length")?.trim();
  if (contentLength !== undefined) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > 0) {
      return Response.json({
        error: "This Cartiva session request does not accept a body.",
        code: "invalid",
      }, {
        status: 400,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  }

  // In Next's live Node runtime an empty browser POST can still expose an
  // empty ReadableStream. Inspect bytes instead of treating a non-null stream
  // object as proof that a body was sent, and cancel on the first byte so a
  // chunked request cannot be buffered without limit.
  if (request.body !== null) {
    const reader = request.body.getReader();
    const consume = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return "empty" as const;
          if (value.byteLength > 0) {
            await reader.cancel().catch(() => undefined);
            return "body" as const;
          }
        }
      } catch {
        return "invalid" as const;
      } finally {
        reader.releaseLock();
      }
    })();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve("timeout");
        try {
          void reader.cancel().catch(() => undefined);
        } catch {
          // The timeout result already won; cancellation is best effort.
        }
      }, BODYLESS_READ_TIMEOUT_MS);
    });
    const raced = await Promise.race([consume, deadline]);
    const result = timedOut ? "timeout" : raced;
    if (timeout) clearTimeout(timeout);
    if (result === "empty") return null;
    if (result === "timeout") {
      return Response.json({
        error: "The Cartiva session request body took too long to arrive.",
        code: "invalid",
      }, {
        status: 408,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  } else {
    return null;
  }
  return Response.json({
    error: "This Cartiva session request does not accept a body.",
    code: "invalid",
  }, {
    status: 400,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function POST(request: Request) {
  const rejectedOrigin = rejectDisallowedMobileBrowserOrigin(request);
  if (rejectedOrigin) return rejectedOrigin;
  const limited = enforcePublicReadRateLimit(
    request,
    "mobile-v1-session",
    { limit: 20, windowMs: 60 * 60_000 },
  );
  if (limited) return withMobileReadCors(limited, request);
  const unexpectedBody = await rejectUnexpectedBody(request);
  if (unexpectedBody) return withMobileReadCors(unexpectedBody, request);

  try {
    const { sessionToken, recoveryToken, expiresAt } = await createMobileSessionCredentials();
    return withMobileReadCors(Response.json({
      sessionToken,
      recoveryToken,
      expiresAt: new Date(expiresAt).toISOString(),
    }, {
      status: 201,
      headers: {
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    }), request);
  } catch (error) {
    return withMobileReadCors(mobileSessionErrorResponse(error), request);
  }
}

export async function DELETE(request: Request) {
  const rejectedOrigin = rejectDisallowedMobileBrowserOrigin(request);
  if (rejectedOrigin) return rejectedOrigin;
  const limited = enforcePublicReadRateLimit(
    request,
    "mobile-v1-session-revoke",
    { limit: 20, windowMs: 60 * 60_000 },
  );
  if (limited) return withMobileSessionCors(limited, request);
  const unexpectedBody = await rejectUnexpectedBody(request);
  if (unexpectedBody) return withMobileSessionCors(unexpectedBody, request);

  try {
    await revokeMobileSessionRecovery(
      request,
      Date.now(),
      disconnectMobileKrogerOwnerStateUnlocked,
    );
    return withMobileSessionCors(new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    }), request);
  } catch (error) {
    return withMobileSessionCors(mobileSessionErrorResponse(error), request);
  }
}
