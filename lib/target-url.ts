import type { TargetProduct } from "./types";

const TARGET_HOST_PATTERN = /^(?:www\.)?target\.com$/i;
const TARGET_PRODUCT_ID_PATTERN = /^(?:\d{8}|\d{10})$/;
const TARGET_PRODUCT_PATH_ID_PATTERN = /^A-(\d{8}|\d{10})$/i;

function normalizedTargetId(value: string | undefined) {
  const cleaned = value?.trim().replace(/^A-/i, "");
  return cleaned && TARGET_PRODUCT_ID_PATTERN.test(cleaned) ? cleaned : undefined;
}

export function createTargetSearchUrl(exactTitle: string) {
  return `https://www.target.com/s?searchTerm=${encodeURIComponent(exactTitle)}`;
}

export function targetProductIdFromUrl(value: string | undefined) {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !TARGET_HOST_PATTERN.test(url.hostname)) return undefined;

    const segments = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    if (segments[0]?.toLowerCase() !== "p") return undefined;

    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const match = segments[index].match(TARGET_PRODUCT_PATH_ID_PATTERN);
      if (match) return match[1];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function isValidTargetProductUrl(
  value: string | undefined,
  identifiers: Array<string | undefined> = [],
) {
  const urlProductId = targetProductIdFromUrl(value);
  if (!urlProductId) return false;

  const reliableIdentifiers = identifiers
    .map(normalizedTargetId)
    .filter((identifier): identifier is string => Boolean(identifier));

  return !reliableIdentifiers.length || reliableIdentifiers.includes(urlProductId);
}

export function resolveTargetLink(
  exactTitle: string,
  sourceUrl?: string,
  identifiers: Array<string | undefined> = [],
): Pick<TargetProduct, "link" | "linkType" | "sourceUrl" | "productPageUnavailable"> {
  if (isValidTargetProductUrl(sourceUrl, identifiers)) {
    return {
      link: sourceUrl!,
      linkType: "product",
      sourceUrl,
      productPageUnavailable: false,
    };
  }

  return {
    link: createTargetSearchUrl(exactTitle),
    linkType: "search",
    sourceUrl,
    productPageUnavailable: true,
  };
}
