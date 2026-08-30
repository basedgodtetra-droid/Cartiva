import type { WalmartProduct } from "./types";

const WALMART_HOST_PATTERN = /^(?:www\.)?walmart\.com$/i;
const REAL_ITEM_ID_PATTERN = /^\d{6,20}$/;
const INVALID_ID_PATTERN = /^(?:demo|fake|stale|result)(?:-|$)/i;

function cleanIdentifier(value: string | undefined) {
  const cleaned = value?.trim();
  return cleaned && !INVALID_ID_PATTERN.test(cleaned) ? cleaned : undefined;
}

export function createWalmartSearchUrl(exactTitle: string) {
  return `https://www.walmart.com/search?q=${encodeURIComponent(exactTitle)}`;
}

export function isValidWalmartProductUrl(
  value: string | undefined,
  identifiers: Array<string | undefined> = [],
) {
  if (!value) return false;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !WALMART_HOST_PATTERN.test(url.hostname)) return false;

    const segments = decodeURIComponent(url.pathname)
      .split("/")
      .filter(Boolean);
    if (segments[0]?.toLowerCase() !== "ip") return false;

    const urlItemId = [...segments].reverse().find((segment) => REAL_ITEM_ID_PATTERN.test(segment));
    if (!urlItemId) return false;

    const realReturnedIds = identifiers
      .map(cleanIdentifier)
      .filter((identifier): identifier is string => Boolean(identifier))
      .filter((identifier) => REAL_ITEM_ID_PATTERN.test(identifier));

    return !realReturnedIds.length || realReturnedIds.includes(urlItemId);
  } catch {
    return false;
  }
}

export function resolveWalmartLink(
  exactTitle: string,
  sourceUrl?: string,
  identifiers: Array<string | undefined> = [],
): Pick<WalmartProduct, "link" | "linkType" | "sourceUrl" | "productPageUnavailable"> {
  if (isValidWalmartProductUrl(sourceUrl, identifiers)) {
    return {
      link: sourceUrl!,
      linkType: "product",
      sourceUrl,
      productPageUnavailable: false,
    };
  }

  return {
    link: createWalmartSearchUrl(exactTitle),
    linkType: "search",
    sourceUrl,
    productPageUnavailable: true,
  };
}
