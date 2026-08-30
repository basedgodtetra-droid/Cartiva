import { siteConfig } from "@/config/site";
import {
  calculateUnitPrice,
  extractMeasurement,
  extractPackOnlyCount,
} from "./measurements";
import {
  assessProduceForm,
  assessProductFamily,
  assessProductVariant,
  extractRequestedBrand,
  inferProductCategory,
  missingRequestedDescriptors,
  productMatchesRequestedBrand,
  productTypeMatchesRequest,
} from "./product-knowledge";
import { productConstraintIssues } from "./product-facets";
import type { ProductConstraint } from "./product-facets";
import type { MatchResult, RankedProduct, WalmartProduct } from "./types";
import {
  createWalmartSearchUrl,
  isValidWalmartProductUrl,
} from "./walmart-url";

function relativeDifference(actual: number, expected: number) {
  return Math.abs(actual - expected) / Math.max(Math.abs(expected), 0.0001);
}

const QUANTITATIVE_PACKAGE_ATTRIBUTES = new Set([
  "bagSize",
  "bottleSize",
  "boxSize",
  "containerSize",
  "count",
  "loafSize",
  "packCount",
  "packageSize",
  "quantity",
  "weightRange",
]);

function hasExplicitPackageRequirement(
  request: string,
  constraints: ProductConstraint[],
) {
  return Boolean(
    extractMeasurement(request)
    || extractPackOnlyCount(request)
    || constraints.some((constraint) => QUANTITATIVE_PACKAGE_ATTRIBUTES.has(constraint.attribute)),
  );
}

function isOnlyUnrequestedPackageMeasurementMissing(
  request: string,
  issues: string[],
  constraints: ProductConstraint[],
) {
  return issues.length === 1
    && issues[0] === "package size could not be verified"
    && !hasExplicitPackageRequirement(request, constraints);
}

export function packageConsistencyIssues(product: WalmartProduct) {
  const issues: string[] = [];
  const size = product.size;
  if (!size) return ["package size could not be verified"];

  if (size.packCount && size.perPackageAmount) {
    const individualBase = size.unit === "lb" ? size.perPackageAmount * 16 : size.perPackageAmount;
    const expectedTotal = individualBase * size.packCount;
    if (relativeDifference(size.baseAmount, expectedTotal) > 0.15) {
      issues.push("pack count and total package size are inconsistent");
    }

    const category = inferProductCategory(`${product.productType ?? ""} ${product.title}`);
    if (
      ["sports drink", "soda", "juice"].includes(category ?? "") &&
      product.price / size.packCount < 0.25
    ) {
      issues.push("pack price appears inconsistent with the package quantity");
    }
  }

  if (product.reportedUnitPrice) {
    if (size.kind === "count" && (!product.reportedUnitBasis || product.reportedUnitBasis === "each")) {
      const expected = product.price / Math.max(size.packCount ?? size.baseAmount, 0.0001);
      if (relativeDifference(product.reportedUnitPrice, expected) > 0.15) {
        issues.push("reported unit price is inconsistent with the total price");
      }
    } else if (size.kind === "count") {
      // Walmart can report eggs and similar count products by weight. The title
      // does not expose that weight, so it is not evidence of a price conflict.
    } else if (!product.reportedUnitBasis) {
      const plausiblePrices = [product.price / Math.max(size.baseAmount, 0.0001)];
      if (size.packCount) plausiblePrices.push(product.price / size.packCount);
      if (plausiblePrices.every(
        (expected) => relativeDifference(product.reportedUnitPrice!, expected) > 0.15,
      )) {
        issues.push("reported unit price is inconsistent with the total price");
      }
    } else {
      let units = size.baseAmount;
      if (product.reportedUnitBasis === "each") units = size.packCount ?? size.baseAmount;
      if (product.reportedUnitBasis === "lb") units = size.baseAmount / 16;
      if (product.reportedUnitBasis === "fl oz" && size.baseUnit !== "fl oz") {
        issues.push("reported unit basis does not match the package type");
      } else if (product.reportedUnitBasis === "oz" && size.baseUnit !== "oz") {
        issues.push("reported unit basis does not match the package type");
      } else {
        const expectedUnitPrice = product.price / Math.max(units, 0.0001);
        if (relativeDifference(product.reportedUnitPrice, expectedUnitPrice) > 0.15) {
          issues.push("reported unit price is inconsistent with the total price");
        }
      }
    }
  }

  return issues;
}

function verifiedExplanation(request: string, product: RankedProduct) {
  const brand = extractRequestedBrand(request);
  const size = product.size?.label;
  const usesLocalizedPrice = product.priceProvenance?.priceScope === "localized";
  const descriptors: string[] = [];
  if (/\bzero\b/i.test(request)) descriptors.push("Zero Sugar");
  if (/\blemon[ -]?lime\b/i.test(request)) descriptors.push("Lemon Lime");
  if (/\bplain\b/i.test(request)) descriptors.push("plain");
  if (size) descriptors.push(size);

  if (brand) {
    return usesLocalizedPrice
      ? `Verified ${brand.canonical} brand${descriptors.length ? `, ${descriptors.join(", ")}` : ""}, and Walmart product details. Selected using a localized Walmart pickup/search price; the exact-store checkout price is not confirmed.`
      : `Verified ${brand.canonical} brand${descriptors.length ? `, ${descriptors.join(", ")}` : ""}, and local Walmart store price. Product details verified separately.`;
  }

  const category = inferProductCategory(`${product.productType ?? ""} ${product.title}`) ?? "product type";
  return usesLocalizedPrice
    ? `No brand specified; verified ${category}${size ? `, ${size}` : ""} and Walmart product details. Selected using a localized Walmart pickup/search price; the exact-store checkout price is not confirmed.`
    : `No brand specified; verified ${category}${size ? `, ${size}` : ""}, and local Walmart store price. Product details verified separately.`;
}

function reviewResult(
  preliminary: MatchResult,
  product: RankedProduct,
  issues: string[],
): MatchResult {
  const exactPageIsUnsafe = issues.some((issue) =>
    /product page|details were unavailable|stale|product identity/i.test(issue),
  );
  const safeProduct = exactPageIsUnsafe
    ? {
        ...product,
        link: createWalmartSearchUrl(product.title),
        linkType: "search" as const,
        productPageUnavailable: true,
      }
    : product;
  return {
    ...preliminary,
    recommended: {
      ...safeProduct,
      confidence: "low",
      verification: issues.some((issue) => /inconsistent|mismatch/i.test(issue))
        ? "suspicious"
        : "unverified",
      verificationIssues: issues,
    },
    confidence: "low",
    status: "review",
    verifiedAt: undefined,
    explanation: `Possible match found, but ${issues.join("; ")}.`,
  };
}

export function verifySelectedProduct(
  request: string,
  preliminary: MatchResult,
  detail: WalmartProduct | null,
  now = new Date(),
  constraints: ProductConstraint[] = [],
  requestedFulfillmentMode: "pickup" | "delivery" | "shipping" = "pickup",
): MatchResult {
  const candidate = preliminary.recommended;
  if (!candidate) return preliminary;

  if (!detail) {
    return reviewResult(preliminary, candidate, [
      "current Walmart product details were unavailable",
      ...(
        candidate.dataSource === "serpapi"
          || candidate.dataSource === "openwebninja"
          || candidate.dataSource === "scrapingbee"
          || candidate.dataSource === "decodo"
          ? [candidate.priceProvenance?.priceScope === "localized"
              ? "localized Walmart pickup/search price needs confirmation"
              : "local Walmart price needs confirmation"]
          : []
      ),
    ]);
  }

  const detailCheckedAt = detail.checkedAt ? new Date(detail.checkedAt) : null;
  const requestedBrand = extractRequestedBrand(request);
  const requestSize = extractMeasurement(request);
  const requestedPackOnly = extractPackOnlyCount(request);
  const allowClosestPackage = Boolean(
    preliminary.assumptions?.some((assumption) => /requested .* unavailable; selected closest/i.test(assumption)),
  );
  const issues: string[] = [];
  const candidatePriceCents = candidate.priceCents ?? Math.round(candidate.price * 100);
  const verifiedUnitPrice = calculateUnitPrice(candidatePriceCents / 100, detail.size);
  const searchProvenance = candidate.priceProvenance;
  const detailProvenance = detail.priceProvenance;
  const searchFulfillment = searchProvenance?.fulfillment ?? [];
  const fulfillment = [...new Set([
    ...searchFulfillment,
    ...(detailProvenance?.fulfillment ?? []),
  ])];
  const isLiveProduct = candidate.dataSource === "serpapi"
    || candidate.dataSource === "openwebninja"
    || candidate.dataSource === "scrapingbee"
    || candidate.dataSource === "decodo";
  const usesLocalizedPrice = isLiveProduct
    && searchProvenance?.priceScope === "localized";
  const shippingOnly = fulfillment.length === 1 && fulfillment[0] === "shipping";
  // A store-scoped Search price can be confirmed for pickup by the selected
  // product's store-scoped details. Delivery is stricter: the Search offer that
  // supplied the basket price must itself advertise delivery, so detail-only
  // metadata can never relabel a pickup price as a verified delivery price.
  const localFulfillmentVerified = requestedFulfillmentMode === "pickup"
    ? fulfillment.includes("pickup") || fulfillment.includes("in_store")
    : requestedFulfillmentMode === "delivery"
      ? searchFulfillment.includes("delivery")
      : false;
  // ScrapingBee Search echoes the applied store and owns the basket price.
  // Product details are deliberately fetched without localization for speed
  // and are used only for identity, stock, fulfillment, and the canonical URL.
  const detailContextConfirmed = detailProvenance?.detailStoreMatched === true
    || Boolean(
      candidate.dataSource === "scrapingbee"
      && detailProvenance?.requestedStoreId
      && detailProvenance.requestedStoreId === searchProvenance?.requestedStoreId,
    );
  const exactStorePriceVerified = !isLiveProduct || Boolean(
    !usesLocalizedPrice
    && searchProvenance?.localPriceEligible
    && searchProvenance.searchStoreMatched
    && searchProvenance.sellerType === "walmart"
    && detailContextConfirmed
    && detailProvenance?.sellerType !== "marketplace"
    && localFulfillmentVerified
    && !shippingOnly,
  );
  // A provider may localize Walmart Search by store/ZIP without returning
  // enough location evidence to prove an exact-store price. That search price
  // can still be used as an honest estimate after identity, seller, stock, and
  // pickup checks; it must never be relabeled as verified exact-store pricing.
  const localizedPriceEligible = Boolean(
    usesLocalizedPrice
    && searchProvenance?.localPriceEligible
    && searchProvenance.sellerType === "walmart"
    && detailProvenance?.sellerType !== "marketplace"
    && localFulfillmentVerified
    && !shippingOnly,
  );
  const basketPriceIsUsable = exactStorePriceVerified || localizedPriceEligible;
  const localPriceVerified = exactStorePriceVerified && !usesLocalizedPrice;
  // Product-detail responses do not always include the canonical Walmart URL.
  // Preserve the exact Search URL when details return only a safe search fallback.
  const verifiedLinkSource = detail.linkType === "product"
    ? detail
    : candidate.linkType === "product" ? candidate : detail;
  const merged: RankedProduct = {
    ...candidate,
    ...detail,
    productId: candidate.productId ?? detail.productId,
    itemId: candidate.itemId ?? detail.itemId,
    upc: candidate.upc ?? detail.upc,
    price: candidatePriceCents / 100,
    priceCents: candidatePriceCents,
    priceProvenance: searchProvenance ? {
      ...searchProvenance,
      productDetailPriceCents: detail.priceCents ?? (
        Number.isFinite(detail.price) ? Math.round(detail.price * 100) : undefined
      ),
      detailStoreId: detailProvenance?.detailStoreId,
      detailLocation: detailProvenance?.detailLocation,
      detailStoreMatched: detailProvenance?.detailStoreMatched,
      fulfillment,
      localPriceVerified,
      verifiedFulfillmentMode: basketPriceIsUsable
        ? requestedFulfillmentMode === "shipping" ? undefined : requestedFulfillmentMode
        : undefined,
    } : detailProvenance,
    score: candidate.score,
    confidence: candidate.confidence,
    comparablePrice: candidate.comparablePrice,
    unitPrice: verifiedUnitPrice?.value,
    unitLabel: verifiedUnitPrice?.label,
    reportedUnitPrice: candidate.reportedUnitPrice ?? detail.reportedUnitPrice,
    reportedUnitBasis: candidate.reportedUnitBasis ?? detail.reportedUnitBasis,
    link: verifiedLinkSource.link,
    linkType: verifiedLinkSource.linkType,
    sourceUrl: verifiedLinkSource.sourceUrl,
    productPageUnavailable: verifiedLinkSource.productPageUnavailable,
    matchedTerms: candidate.matchedTerms,
    reasons: candidate.reasons,
    checkedAt: searchProvenance?.checkedAt ?? candidate.checkedAt ?? detail.checkedAt,
    verification: "unverified",
  };

  if (!Number.isFinite(detail.price) || detail.price <= 0) issues.push("current product-detail price is missing");
  if (!Number.isFinite(candidate.price) || candidate.price <= 0) {
    issues.push("local Walmart search price is missing");
  }
  let checkedAtIsFresh = false;
  if (!detailCheckedAt || Number.isNaN(detailCheckedAt.getTime())) {
    issues.push("product-detail check time is missing");
  } else if (now.getTime() - detailCheckedAt.getTime() > siteConfig.detailCacheTtlMs) {
    issues.push("product-detail price is stale");
  } else {
    checkedAtIsFresh = true;
  }
  if (!detail.inStock) issues.push("the product is not currently in stock");
  if (detail.dataSource === "mock") {
    issues.push("this is curated demo data, not a live Walmart product");
  }
  if (isLiveProduct) {
    if (searchProvenance?.sellerType !== "walmart") {
      issues.push("the selected offer is not sold by Walmart");
    }
    if (detailProvenance?.sellerType === "marketplace") {
      issues.push("product details identify a third-party marketplace seller");
    }
    if (requestedFulfillmentMode === "shipping") {
      issues.push("shipping-specific price provenance is unavailable");
    } else if (shippingOnly) {
      issues.push("the offer is shipping-only");
    } else if (!localFulfillmentVerified) {
      issues.push(requestedFulfillmentMode === "delivery"
        ? "delivery availability was not attached to the selected search price"
        : "pickup or in-store availability was not attached to the selected search price");
    }
    if (usesLocalizedPrice) {
      if (!localizedPriceEligible) {
        issues.push("localized Walmart pickup/search price needs confirmation");
      }
    } else {
      if (!searchProvenance?.searchStoreMatched) {
        issues.push("the local search response did not confirm the selected store");
      }
      if (!detailContextConfirmed) {
        issues.push("product details did not confirm the selected store");
      }
      if (!localPriceVerified) issues.push("local Walmart price needs confirmation");
    }
  }
  const sameItemId = Boolean(
    candidate.itemId
    && detail.itemId
    && candidate.itemId === detail.itemId,
  );
  if (
    !sameItemId
    && candidate.productId
    && detail.productId
    && candidate.productId !== detail.productId
  ) {
    issues.push("product identity does not match the selected search result");
  }
  const productUrlIsVerified = merged.linkType === "product" && isValidWalmartProductUrl(
    merged.link,
    [merged.productId, merged.itemId, merged.upc],
  );
  if (!productUrlIsVerified) issues.push("the Walmart product page is unavailable");
  if (requestedBrand && !productMatchesRequestedBrand(requestedBrand, detail)) {
    issues.push(`brand does not match requested ${requestedBrand.canonical}`);
  }
  const missingDescriptors = missingRequestedDescriptors(request, detail);
  if (missingDescriptors.length) {
    issues.push(`product does not confirm ${missingDescriptors.join(" and ")}`);
  }
  if (!productTypeMatchesRequest(request, detail)) issues.push("product type does not match the request");
  const produceFormAssessment = assessProduceForm(request, detail);
  if (produceFormAssessment.rejected) issues.push(...produceFormAssessment.reasons);
  const variantAssessment = assessProductVariant(request, detail);
  if (variantAssessment.rejected) issues.push(...variantAssessment.reasons);
  const familyAssessment = assessProductFamily(request, detail);
  if (familyAssessment.rejected) issues.push(...familyAssessment.reasons);
  issues.push(...productConstraintIssues(detail, constraints));

  if (!detail.size) {
    issues.push("package size could not be verified");
  } else if (requestedPackOnly) {
    if (detail.size.packCount !== requestedPackOnly && !allowClosestPackage) {
      issues.push("verified pack count differs from the request");
    }
  } else if (requestSize) {
    if (requestSize.kind !== detail.size.kind) {
      issues.push("package measurement type does not match the request");
    } else {
      const packCountDiffers = Boolean(
        requestSize.packCount
        && detail.size.packCount !== requestSize.packCount,
      );
      if (
        allowClosestPackage
        && packCountDiffers
        && requestSize.perPackageAmount
        && detail.size.perPackageAmount
      ) {
        if (relativeDifference(detail.size.perPackageAmount, requestSize.perPackageAmount) > 0.15) {
          issues.push("verified individual package size differs from the request");
        }
      } else if (relativeDifference(detail.size.baseAmount, requestSize.baseAmount) > 0.15) {
        issues.push("verified package size differs from the request");
      }
    }
    if (
      requestSize.packCount &&
      detail.size.packCount !== requestSize.packCount &&
      !allowClosestPackage
    ) {
      issues.push("verified pack count differs from the request");
    }
  }

  issues.push(...packageConsistencyIssues(merged));
  const uniqueIssues = [...new Set(issues)];
  const useBestReasonablePackageAssumption = isOnlyUnrequestedPackageMeasurementMissing(
    request,
    uniqueIssues,
    constraints,
  );
  if (uniqueIssues.length && !useBestReasonablePackageAssumption) {
    return reviewResult(preliminary, merged, uniqueIssues);
  }

  if (!checkedAtIsFresh || !productUrlIsVerified) {
    return reviewResult(preliminary, merged, ["the Walmart product page is unavailable"]);
  }

  const verifiedAt = searchProvenance?.checkedAt
    ?? candidate.checkedAt
    ?? detailCheckedAt!.toISOString();
  const verifiedProduct: RankedProduct = {
    ...merged,
    confidence: usesLocalizedPrice || useBestReasonablePackageAssumption ? "medium" : "high",
    verification: "verified",
    verificationIssues: [],
    checkedAt: verifiedAt,
  };
  const assumptions = [...(preliminary.assumptions ?? [])];
  if (
    useBestReasonablePackageAssumption
    && !assumptions.some((assumption) => /package size/i.test(assumption))
  ) {
    assumptions.push("Assumed a common package size");
  }
  if (
    usesLocalizedPrice
    && !assumptions.some((assumption) => /localized Walmart/i.test(assumption))
  ) {
    assumptions.push("Localized Walmart pickup/search price; exact-store checkout price may differ");
  }
  return {
    ...preliminary,
    recommended: verifiedProduct,
    assumptions,
    confidence: usesLocalizedPrice || useBestReasonablePackageAssumption ? "medium" : "high",
    status: "matched",
    verifiedAt,
    explanation: useBestReasonablePackageAssumption
      ? `${verifiedExplanation(request, verifiedProduct)} Walmart did not report a package measurement, so Cartiva selected this best reasonable standard option.`
      : verifiedExplanation(request, verifiedProduct),
  };
}
