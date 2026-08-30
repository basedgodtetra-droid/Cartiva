import {
  extensionCorsHeaders,
  isAllowedExtensionOrigin,
  withExtensionCors,
} from "@/lib/extension-cors";
import {
  enforceRateLimit,
  hasOnlyKeys,
  isRecord,
  readValidatedJson,
  trustValidatedExtensionRequest,
} from "@/lib/api-security";
import { normalizeShoppingItem } from "@/lib/list-parser";
import {
  analyzeProductFacets,
  buildFacetSearchQuery,
} from "@/lib/product-facets";
import { searchWalmart, WalmartSearchError } from "@/lib/walmart-provider";
import { deriveWalmartSearchIdeas } from "@/lib/walmart-search-ideas";
import {
  eligibleWalmartSuggestionProducts,
  selectWalmartSuggestions,
} from "@/lib/walmart-suggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SuggestionBody {
  query?: unknown;
  storeId?: unknown;
  zipCode?: unknown;
  state?: unknown;
}

function rejectedOrigin() {
  return Response.json(
    { error: "This origin is not allowed to use the Cartiva extension API." },
    {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        Vary: "Origin",
      },
    },
  );
}

function jsonWithCors(data: unknown, status: number, origin: string) {
  const headers = extensionCorsHeaders(origin);
  headers.set("Cache-Control", "no-store");
  return Response.json(data, { status, headers });
}

function normalizedSuggestionQuery(value: unknown) {
  if (typeof value !== "string") return undefined;
  const query = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return query.length >= 3 && query.length <= 160 ? query : undefined;
}

function validStoreId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,8}$/.test(value.trim());
}

function errorResponse(error: unknown, origin: string) {
  if (error instanceof WalmartSearchError) {
    if (error.code === "rate_limit") {
      return jsonWithCors(
        { error: "Walmart suggestions are temporarily rate-limited. Try again shortly." },
        429,
        origin,
      );
    }
    if (error.code === "timeout") {
      return jsonWithCors(
        { error: "Walmart suggestions took too long to respond. Try again." },
        504,
        origin,
      );
    }
    if (error.code === "configuration") {
      return jsonWithCors(
        { error: "Choose a Walmart pickup store before requesting suggestions." },
        400,
        origin,
      );
    }
  }

  return jsonWithCors(
    { error: "Walmart suggestions are temporarily unavailable. Keep typing or try again." },
    502,
    origin,
  );
}

export function OPTIONS(request: Request) {
  const origin = request.headers.get("Origin");
  if (!isAllowedExtensionOrigin(origin)) return rejectedOrigin();

  const requestedMethod = request.headers.get("Access-Control-Request-Method");
  if (requestedMethod && requestedMethod.toUpperCase() !== "POST") {
    return jsonWithCors({ error: "Only POST requests are supported." }, 405, origin!);
  }

  const requestedHeaders = request.headers
    .get("Access-Control-Request-Headers")
    ?.split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean) ?? [];
  if (requestedHeaders.some((header) => header !== "content-type")) {
    return jsonWithCors({ error: "The requested CORS headers are not allowed." }, 400, origin!);
  }

  return new Response(null, {
    status: 204,
    headers: extensionCorsHeaders(origin!),
  });
}

export async function POST(request: Request) {
  const origin = request.headers.get("Origin");
  if (!isAllowedExtensionOrigin(origin)) return rejectedOrigin();

  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return jsonWithCors({ error: "Send the extension request as JSON." }, 415, origin!);
  }

  const trusted = trustValidatedExtensionRequest(request);
  const limited = enforceRateLimit(trusted, "walmart-suggestions", { limit: 45, windowMs: 60_000 });
  if (limited) return withExtensionCors(limited, origin!);
  const parsed = await readValidatedJson<unknown>(trusted);
  if (!parsed.ok) return withExtensionCors(parsed.response, origin!);
  if (!isRecord(parsed.value) || !hasOnlyKeys(
    parsed.value,
    ["query", "storeId", "zipCode", "state"],
  )) {
    return jsonWithCors({ error: "The suggestion request contains unsupported fields." }, 400, origin!);
  }
  const body = parsed.value as SuggestionBody;

  const query = normalizedSuggestionQuery(body.query);
  if (!query) {
    return jsonWithCors(
      { error: "Enter between 3 and 160 characters for one grocery item." },
      400,
      origin!,
    );
  }
  if (!validStoreId(body.storeId)) {
    return jsonWithCors(
      { error: "Choose a valid Walmart pickup store before requesting suggestions." },
      400,
      origin!,
    );
  }
  const zipCode = typeof body.zipCode === "string" ? body.zipCode.trim() : "";
  const state = typeof body.state === "string" ? body.state.trim().toUpperCase() : "";
  if (zipCode && !/^\d{5}$/.test(zipCode)) {
    return jsonWithCors({ error: "Enter a valid 5-digit ZIP code." }, 400, origin!);
  }
  if (state && !/^[A-Z]{2}$/.test(state)) {
    return jsonWithCors({ error: "Choose a valid U.S. state." }, 400, origin!);
  }

  try {
    const facets = analyzeProductFacets(query);
    // Send Walmart the shopper's actual words. Rebuilding this from known
    // facets can silently drop meaningful qualifiers such as "diet" or a
    // flavor Cartiva has not modeled yet.
    const walmartQuery = normalizeShoppingItem(
      buildFacetSearchQuery(query, facets.constraints),
    );
    const search = await searchWalmart(
      walmartQuery,
      body.storeId.trim(),
      request.signal,
      {
        fulfillmentMode: "pickup",
        zipCode,
        state,
      },
    );
    const eligibleProducts = eligibleWalmartSuggestionProducts(
      query,
      search.products,
      facets.constraints,
    );
    const searchIdeas = deriveWalmartSearchIdeas(
      query,
      eligibleProducts,
      search.suggestionSignals ?? [],
    );
    const suggestions = selectWalmartSuggestions(
      query,
      search.products,
      facets.constraints,
    );

    return jsonWithCors({
      query,
      mode: search.mode,
      searchIdeas,
      suggestions,
    }, 200, origin!);
  } catch (error) {
    return errorResponse(error, origin!);
  }
}
