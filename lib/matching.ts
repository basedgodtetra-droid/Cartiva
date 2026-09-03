import {
  calculateComparablePrice,
  calculateUnitPrice,
  extractMeasurement,
  extractPackOnlyCount,
} from "./measurements";
import {
  assessProduceForm,
  assessProductFamily,
  assessProductVariant,
  clarificationForRequest,
  extractProduceIdentity,
  extractRequestedBrand,
  inferProductCategory,
  isGenericProduceRequest,
  missingRequestedDescriptors,
  productMatchesRequestedBrand,
  productTypeMatchesRequest,
  stripFlexibleProteinPreferences,
} from "./product-knowledge";
import { productConstraintIssues } from "./product-facets";
import type { ProductConstraint } from "./product-facets";
import type {
  Confidence,
  MatchResult,
  WalmartCandidateDiagnostic,
  WalmartProduct,
} from "./types";

const STOP_WORDS = new Set([
  "a", "an", "and", "the", "of", "for", "with", "get", "buy", "need", "want",
  "please", "cheapest", "available", "generic", "okay", "ok", "fine", "high",
  "protein", "no", "oz", "ounce", "ounces", "fl", "lb", "lbs", "pound", "pounds",
  "count", "ct", "pack", "pk",
]);

const FLAVORS = [
  "plain",
  "vanilla",
  "strawberry",
  "chocolate",
  "original",
  "unsweetened",
  "unflavored",
  "garlic",
  "alfredo",
  "lemon",
  "lime",
  "zero",
];

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function words(value: string) {
  return normalize(value).split(/\s+/).filter(Boolean);
}

function importantWords(value: string) {
  return words(value).filter(
    (word) => !STOP_WORDS.has(word) && !/^\d+(?:\.\d+)?$/.test(word),
  );
}

const TERM_MATCH_ALIASES: Record<string, string[]> = {
  chickpea: ["chickpeas", "garbanzo", "peas"],
  chickpeas: ["chickpea", "garbanzo", "peas"],
  garbanzo: ["chickpea", "chickpeas", "peas"],
  light: ["lite"],
  lite: ["light"],
};

function titleMatchesImportantWord(word: string, titleWords: Set<string>) {
  return titleWords.has(word)
    || (TERM_MATCH_ALIASES[word] ?? []).some((alias) => titleWords.has(alias));
}

function confidenceFor(score: number): Confidence {
  if (score >= 78) return "high";
  if (score >= 62) return "medium";
  return "low";
}

function commonPackagePreference(request: string, product: WalmartProduct) {
  const requestHasSize = Boolean(extractMeasurement(request));
  const normalizedRequest = normalize(request);
  if (!requestHasSize && /\beggs?\b/.test(normalizedRequest) && product.size?.kind === "count") {
    const count = product.size.packCount ?? product.size.baseAmount;
    if (count === 12 || count === 18) {
      return { score: 18, reason: "standard egg carton size" };
    }
    if (count < 12) return { score: -10, reason: "small egg carton" };
  }

  if (requestHasSize || !extractRequestedBrand(request) || !product.size) {
    return { score: 0, reason: undefined as string | undefined };
  }

  const title = normalize(product.title);
  const isBeverage = /\b(?:soda|cola|gatorade|sports drink|juice|beverage)\b/.test(title);
  if (isBeverage) {
    if (product.size.packCount && product.size.packCount >= 6 && product.size.packCount <= 24) {
      return { score: 18, reason: "common multipack size" };
    }
    if (!product.size.packCount && product.size.baseAmount <= 32) {
      return { score: -12, reason: "single-serve package" };
    }
  }

  if (/\bbag\b/.test(title) && product.size.kind === "weight") {
    if (product.size.baseAmount >= 7 && product.size.baseAmount <= 14) {
      return { score: 18, reason: "standard bag size" };
    }
    if (product.size.baseAmount <= 3.5) {
      return { score: -18, reason: "snack-size bag" };
    }
  }

  if (!product.size.packCount) return { score: 4, reason: "common single package" };
  return { score: 0, reason: undefined as string | undefined };
}

function assumptionsForMatch(request: string, product: WalmartProduct) {
  const brand = extractRequestedBrand(request);
  if (!brand || extractMeasurement(request)) return [];

  const assumptions: string[] = [];
  if (/\bbag\b/i.test(product.title)) {
    assumptions.push("Assumed standard bag");
  } else if (product.size?.packCount) {
    assumptions.push(`Assumed common ${product.size.packCount}-pack`);
  } else {
    assumptions.push("Assumed a common package size");
  }

  if (brand.canonical === "Takis" && !/\b(?:fuego|blue heat|nitro|intense nacho|crunchy fajitas)\b/i.test(request)) {
    const selectedFlavor = product.title.match(/\b(Fuego|Blue Heat|Nitro|Intense Nacho|Crunchy Fajitas)\b/i)?.[1];
    if (selectedFlavor) assumptions.push(`Assumed ${selectedFlavor} flavor`);
  }

  return assumptions;
}

function scoreProduct(
  request: string,
  product: WalmartProduct,
  constraints: ProductConstraint[] = [],
) {
  const requestWords = importantWords(stripFlexibleProteinPreferences(request));
  const titleWords = new Set(words(`${product.brand ?? ""} ${product.title}`));
  const matchedTerms = [...new Set(requestWords.filter((word) => (
    titleMatchesImportantWord(word, titleWords)
  )))];
  const ratio = requestWords.length ? matchedTerms.length / requestWords.length : 0;
  const reasons: string[] = [];
  let score = ratio * 58;
  let rejected = false;

  if (!Number.isFinite(product.price) || product.price <= 0) {
    rejected = true;
    reasons.push("current price is missing or invalid");
  }

  if (product.inStock || product.availabilityStatus === "in_stock") {
    score += 9;
    reasons.push("verified in stock");
  } else if (product.availabilityStatus === "likely_available") {
    score += 6;
    reasons.push("listed for the selected fulfillment method; inventory level was not reported");
  } else if (product.availabilityStatus === "unknown") {
    reasons.push("product and price verified; current availability was not reported");
  } else {
    rejected = true;
    reasons.push("out of stock");
  }

  if (product.priceProvenance?.sellerType === "marketplace") {
    rejected = true;
    reasons.push("third-party marketplace seller is not eligible for the local basket");
  } else if (product.seller && /walmart/i.test(product.seller)) {
    score += 8;
    reasons.push("sold by Walmart");
  } else if (product.seller) {
    score -= 7;
    reasons.push("marketplace seller");
  }

  const provenance = product.priceProvenance;
  if (provenance) {
    if (provenance.searchStoreMatched === false) {
      rejected = true;
      reasons.push("search response store does not match the selected Walmart");
    }
    const shippingOnly = provenance.fulfillment.length === 1
      && provenance.fulfillment[0] === "shipping";
    const fulfillmentAwaitsDetail = product.dataSource === "scrapingbee"
      && provenance.searchStoreMatched === true;
    if (shippingOnly && !fulfillmentAwaitsDetail) {
      rejected = true;
      reasons.push("shipping-only offer is not eligible for the local basket");
    }
    const isLiveWalmartProduct = product.dataSource === "serpapi"
      || product.dataSource === "openwebninja"
      || product.dataSource === "scrapingbee"
      || product.dataSource === "decodo";
    if (isLiveWalmartProduct && !provenance.localPriceEligible) {
      rejected = true;
      reasons.push("local Walmart store price is not eligible");
    } else if (provenance.localPriceEligible) {
      score += 16;
      reasons.push(provenance.priceScope === "localized"
        ? "eligible localized Walmart pickup/search price"
        : "eligible store-specific Walmart price");
    }
  }

  if (product.sponsored) {
    score -= 14;
    reasons.push("sponsored result");
  }

  const requestedBrand = extractRequestedBrand(request);
  let requestedBrandMatched = false;
  if (requestedBrand) {
    if (productMatchesRequestedBrand(requestedBrand, product)) {
      requestedBrandMatched = true;
      score += 18;
      reasons.push(`matches required ${requestedBrand.canonical} brand`);
    } else {
      rejected = true;
      reasons.push(`brand does not match required ${requestedBrand.canonical}`);
    }
  }

  // A recognized brand alone is not sufficient for categories that have not
  // yet been modeled by facets. "Dove shampoo" must not match Dove body wash.
  if (requestedBrandMatched && !inferProductCategory(request)) {
    const brandWords = new Set(
      [requestedBrand!.canonical, ...requestedBrand!.aliases]
        .flatMap((value) => words(value)),
    );
    const requestedIdentityWords = requestWords.filter((word) => !brandWords.has(word));
    const candidateIdentityWords = new Set(
      words(`${product.brand ?? ""} ${product.productType ?? ""} ${product.title}`),
    );
    const matchedIdentityWord = requestedIdentityWords.some((word) => (
      candidateIdentityWords.has(word)
    ));
    if (requestedIdentityWords.length && !matchedIdentityWord) {
      rejected = true;
      reasons.push("brand matched, but the core product identity did not");
    }
  }

  const packagePreference = commonPackagePreference(request, product);
  score += packagePreference.score;
  if (packagePreference.reason) reasons.push(packagePreference.reason);

  const missingDescriptors = missingRequestedDescriptors(request, product);
  if (missingDescriptors.length) {
    rejected = true;
    reasons.push(`does not match required ${missingDescriptors.join(" and ")}`);
  }

  const constraintIssues = productConstraintIssues(product, constraints);
  if (constraintIssues.length) {
    rejected = true;
    reasons.push(...constraintIssues);
  }

  const normalizedRequest = normalize(request);
  const normalizedTitle = normalize(product.title);

  const productTypeMatched = productTypeMatchesRequest(request, product);
  if (!productTypeMatched) {
    rejected = true;
    reasons.push("product category is unrelated");
  }
  const requestedSemanticCategory = inferProductCategory(request);
  const semanticCategoryMatched = Boolean(
    requestedSemanticCategory
    && requestedSemanticCategory !== "produce"
    && productTypeMatched,
  );
  if (semanticCategoryMatched) {
    score += 12;
    reasons.push(`matches ${requestedSemanticCategory} product category`);
  }

  const produceFormAssessment = assessProduceForm(request, product);
  score += produceFormAssessment.scoreAdjustment;
  if (produceFormAssessment.rejected) rejected = true;
  reasons.push(...produceFormAssessment.reasons);

  const genericProduceMatched = isGenericProduceRequest(request)
    && productTypeMatched
    && !produceFormAssessment.rejected;
  if (genericProduceMatched) {
    score += 24;
    reasons.push("concrete option for a broad produce request");
  }

  const requestedProduceIdentity = extractProduceIdentity(request);
  const candidateProduceIdentity = extractProduceIdentity(
    `${product.productType ?? ""} ${product.title}`,
  );
  const concreteProduceIdentityMatched = Boolean(
    requestedProduceIdentity
    && requestedProduceIdentity === candidateProduceIdentity
    && productTypeMatched
    && !produceFormAssessment.rejected,
  );
  if (concreteProduceIdentityMatched) {
    score += 18;
    reasons.push(`matches ${requestedProduceIdentity} produce identity`);
  }

  const variantAssessment = assessProductVariant(request, product);
  score += variantAssessment.scoreAdjustment;
  if (variantAssessment.rejected) rejected = true;
  reasons.push(...variantAssessment.reasons);

  const familyAssessment = assessProductFamily(request, product);
  score += familyAssessment.scoreAdjustment;
  if (familyAssessment.rejected) rejected = true;
  reasons.push(...familyAssessment.reasons);

  const requestedFlavor = FLAVORS.find((flavor) => normalizedRequest.includes(flavor));
  const negativeFlavor = request.match(/\bno\s+([a-z]+)\b/i)?.[1]?.toLowerCase();

  if (negativeFlavor && normalizedTitle.includes(negativeFlavor)) {
    rejected = true;
    reasons.push(`contains excluded flavor ${negativeFlavor}`);
  }

  if (requestedFlavor) {
    const implicitOriginal = requestedFlavor === "original"
      && !FLAVORS.some((flavor) => flavor !== "original" && normalizedTitle.includes(flavor));
    if (normalizedTitle.includes(requestedFlavor) || implicitOriginal) {
      score += 10;
      reasons.push(implicitOriginal ? "standard/original variety" : `matches ${requestedFlavor}`);
    } else if (FLAVORS.some((flavor) => normalizedTitle.includes(flavor))) {
      rejected = true;
      reasons.push(`flavor does not match ${requestedFlavor}`);
    } else {
      rejected = true;
      reasons.push(`does not confirm ${requestedFlavor}`);
    }
  }

  const requestedSize = extractMeasurement(request);
  const requestedPackOnly = extractPackOnlyCount(request);
  if (requestedSize && product.size) {
    if (requestedPackOnly) {
      if (product.size.packCount === requestedPackOnly) {
        score += 18;
        reasons.push(`matches ${requestedPackOnly}-pack`);
      } else {
        rejected = true;
        reasons.push("pack count does not match the request");
      }
    } else if (requestedSize.kind !== product.size.kind) {
      rejected = true;
      reasons.push("package measurement type is not comparable");
    } else if (
      requestedSize.packCount &&
      product.size.packCount !== requestedSize.packCount
    ) {
      rejected = true;
      reasons.push("pack count does not match the request");
    } else {
      const sizeRatio = product.size.baseAmount / requestedSize.baseAmount;
      const difference = Math.abs(1 - sizeRatio);
      if (difference <= 0.02) {
        score += 18;
        reasons.push(`matches ${requestedSize.label}`);
      } else {
        rejected = true;
        reasons.push("package size does not match the request");
      }

      if (
        !requestedSize.packCount &&
        product.size.packCount &&
        product.size.packCount > 1 &&
        /yogurt|tub|container/.test(normalizedRequest)
      ) {
        rejected = true;
        reasons.push("multi-pack format differs from the request");
      }
    }
  } else if (requestedSize && !product.size) {
    rejected = true;
    reasons.push("package size is missing");
  }

  if (
    (ratio < 0.25 || matchedTerms.length === 0)
    && !requestedBrandMatched
    && !semanticCategoryMatched
    && !genericProduceMatched
    && !concreteProduceIdentityMatched
  ) {
    rejected = true;
    reasons.push("too few important words match");
  }

  return { score, rejected, reasons, matchedTerms, requestedSize };
}

function centsToPrice(value?: number) {
  return value === undefined ? undefined : value / 100;
}

export function auditProductCandidates(
  request: string,
  products: WalmartProduct[],
  constraints: ProductConstraint[] = [],
): WalmartCandidateDiagnostic[] {
  return products.map((product) => {
    const assessment = scoreProduct(request, product, constraints);
    const provenance = product.priceProvenance;
    const belowThreshold = !assessment.rejected && assessment.score < 38;
    return {
      title: product.title,
      brand: product.brand,
      productId: product.productId,
      itemId: product.itemId,
      seller: product.seller,
      sellerType: provenance?.sellerType
        ?? (product.seller && /walmart/i.test(product.seller) ? "walmart" : "unknown"),
      currentPrice: product.price,
      regularPrice: centsToPrice(provenance?.regularPriceCents),
      salePrice: centsToPrice(provenance?.salePriceCents),
      unitPrice: product.reportedUnitPrice,
      unitPriceBasis: product.reportedUnitBasis,
      fulfillment: provenance?.fulfillment ?? [],
      storeId: provenance?.searchStoreId,
      priceSource: provenance?.priceSource,
      rejectionReason: assessment.rejected
        ? assessment.reasons.join("; ")
        : belowThreshold
          ? "match score was below the reliability threshold"
          : undefined,
    };
  });
}

export function rankProducts(
  request: string,
  products: WalmartProduct[],
  constraints: ProductConstraint[] = [],
  preferredIdentity?: {
    productId?: string;
    itemId?: string;
    title?: string;
  },
): MatchResult {
  const clarification = clarificationForRequest(request);
  if (clarification) {
    return {
      requestedItem: request,
      recommended: null,
      alternatives: [],
      confidence: "low",
      status: "review",
      clarification,
      explanation: clarification,
    };
  }

  const scoreCandidates = () => products
    .map((product) => {
      const assessment = scoreProduct(
        request,
        product,
        constraints,
      );
      const unit = calculateUnitPrice(product.price, product.size);
      return {
        ...product,
        score: assessment.score,
        confidence: "low" as Confidence,
        unitPrice: unit?.value,
        unitLabel: unit?.label,
        comparablePrice: calculateComparablePrice(product, assessment.requestedSize),
        matchedTerms: assessment.matchedTerms,
        reasons: assessment.reasons,
        rejected: assessment.rejected,
        verification: "unverified" as const,
      };
    })
    .filter((product) => !product.rejected);

  const scored = scoreCandidates();

  if (!scored.length) {
    const requestedBrand = extractRequestedBrand(request);
    return {
      requestedItem: request,
      recommended: null,
      alternatives: [],
      confidence: "low",
      status: "no_match",
      explanation: requestedBrand
        ? `No verified ${requestedBrand.canonical} match found.`
        : "No reliable Walmart match met the product-type and package requirements.",
    };
  }

  // Decide semantic eligibility and confidence before looking at price.
  // Price may order candidates that already cleared the product/constraint
  // boundary, but a cheap wrong product can never buy its way into acceptance.
  const semanticallyEligible = scored
    .map(({ rejected, ...product }) => {
      void rejected;
      const preferredIdMatched = Boolean(
        (preferredIdentity?.productId && product.productId === preferredIdentity.productId)
        || (preferredIdentity?.itemId && product.itemId === preferredIdentity.itemId),
      );
      const preferredTitleMatched = Boolean(
        preferredIdentity?.title
        && normalize(product.title) === normalize(preferredIdentity.title),
      );
      const semanticScore = product.score
        + (preferredIdMatched ? 80 : preferredTitleMatched ? 35 : 0);
      return {
        ...product,
        semanticScore,
        confidence: confidenceFor(semanticScore),
        reasons: preferredIdMatched
          ? [...product.reasons, "selected from live Walmart suggestions"]
          : product.reasons,
      };
    })
    .filter((product) => product.semanticScore >= 38);

  const cheapestComparable = Math.min(
    ...semanticallyEligible.map((product) => product.comparablePrice),
  );
  const ranked = semanticallyEligible
    .map(({ semanticScore, ...product }) => {
      const valueRatio = cheapestComparable / Math.max(product.comparablePrice, 0.01);
      const finalScore = semanticScore + valueRatio * 12;
      return {
        ...product,
        score: Number(finalScore.toFixed(1)),
      };
    })
    .sort((a, b) => b.score - a.score || a.comparablePrice - b.comparablePrice);

  if (!ranked.length) {
    return {
      requestedItem: request,
      recommended: null,
      alternatives: [],
      confidence: "low",
      status: "no_match",
      explanation: "No reliable match was close enough to the request.",
    };
  }

  const assumptions = assumptionsForMatch(request, ranked[0]);

  return {
    requestedItem: request,
    recommended: ranked[0],
    alternatives: ranked.slice(1, 4),
    assumptions,
    confidence: "low",
    status: "review",
    explanation: "Possible match found. Cartiva is verifying current Walmart product details.",
  };
}
