export type MeasurementKind = "weight" | "volume" | "count";

export interface Measurement {
  amount: number;
  unit: "oz" | "lb" | "fl oz" | "count";
  kind: MeasurementKind;
  baseAmount: number;
  baseUnit: "oz" | "fl oz" | "each";
  packCount?: number;
  perPackageAmount?: number;
  label: string;
}

export type Retailer = "walmart" | "target" | "kroger";
export type RetailFulfillmentMode = "pickup" | "delivery" | "shipping";
export type RetailPriceScope = "exact_store" | "localized" | "estimated";
export type RetailPriceReliability = "verified" | "localized_estimate" | "unreliable";
export type RetailAvailabilityStatus =
  | "in_stock"
  | "likely_available"
  | "out_of_stock"
  | "unknown";

/**
 * Location evidence must describe values observed in a retailer response.
 * Requested values alone are never proof that a price belongs to that store.
 */
export interface RetailLocationEvidence {
  requestedStoreId?: string;
  observedStoreId?: string;
  requestedPostalCode?: string;
  observedPostalCode?: string;
  responseProvesLocation: boolean;
  storeMatched?: boolean;
  postalCodeMatched?: boolean;
}

export interface RetailPriceTrust {
  retailer: Retailer;
  priceScope: RetailPriceScope;
  priceReliability: RetailPriceReliability;
  exactStoreVerified: boolean;
  location: RetailLocationEvidence;
  fulfillment: RetailFulfillmentMode[];
  checkedAt?: string;
}

export type RetailerMetadataAttribute = "title" | "brand" | "productType" | "size";

/** Shared catalog fields; retailer-specific trust metadata stays discriminated. */
export interface RetailProductCore {
  retailer?: Retailer;
  id: string;
  productId?: string;
  itemId?: string;
  upc?: string;
  title: string;
  price: number;
  priceCents?: number;
  link: string;
  linkType?: "product" | "search";
  sourceUrl?: string;
  productPageUnavailable?: boolean;
  thumbnail?: string;
  seller?: string;
  brand?: string;
  productType?: string;
  inStock: boolean;
  availabilityStatus?: RetailAvailabilityStatus;
  sponsored: boolean;
  size?: Measurement;
  /** Retailer-supplied facts stay candidate metadata and never become shopper requirements. */
  attributeOrigins?: Partial<Record<RetailerMetadataAttribute, "RETAILER_METADATA">>;
  reportedUnitPrice?: number;
  reportedUnitBasis?: "oz" | "fl oz" | "lb" | "each";
  checkedAt?: string;
  verification?: "verified" | "unverified" | "suspicious";
  verificationIssues?: string[];
}

export interface RetailSearchContext {
  retailer: Retailer;
  fulfillmentMode: RetailFulfillmentMode;
  storeId?: string;
  postalCode?: string;
}

export interface RetailProviderDiagnostics {
  apiCall?: boolean;
  cacheHit?: boolean;
  durationMs?: number;
}

export interface RetailProviderSearchResult<TProduct extends RetailProductCore> {
  retailer: Retailer;
  products: TProduct[];
  diagnostics?: RetailProviderDiagnostics;
}

export interface RetailProviderDetailResult<TProduct extends RetailProductCore> {
  retailer: Retailer;
  product: TProduct | null;
  diagnostics?: RetailProviderDiagnostics;
}

export interface RetailerProvider<TProduct extends RetailProductCore> {
  retailer: Retailer;
  search(
    query: string,
    context: RetailSearchContext,
    signal?: AbortSignal,
  ): Promise<RetailProviderSearchResult<TProduct>>;
  getProduct(
    productId: string,
    context: RetailSearchContext,
    signal?: AbortSignal,
  ): Promise<RetailProviderDetailResult<TProduct>>;
}

export type WalmartFulfillmentType = "in_store" | "pickup" | "delivery" | "shipping";
export type WalmartSellerType = "walmart" | "marketplace" | "unknown";

export interface WalmartResponseLocation {
  storeId?: string;
  postalCode?: string;
  city?: string;
  provinceCode?: string;
  country?: string;
}

export interface WalmartStoreOption {
  storeId: string;
  postalCode: string;
  address: string;
  country: "US";
}

export interface WalmartStoreLookupResult {
  zipCode: string;
  stores: WalmartStoreOption[];
  totalMatches: number;
}

export type WalmartPriceSource =
  | "local_store_search"
  | "local_store_sale"
  | "walmart_search"
  | "marketplace_search"
  | "product_detail"
  | "demo";

export interface WalmartPriceProvenance {
  priceSource: WalmartPriceSource;
  /**
   * `exact_store` means the price was tied to a confirmed Walmart store.
   * `localized` means Walmart localized the search by store/ZIP, but the
   * upstream response did not prove that exact-store price at checkout.
   */
  priceScope?: "exact_store" | "localized";
  searchPriceCents?: number;
  productDetailPriceCents?: number;
  salePriceCents?: number;
  regularPriceCents?: number;
  shippingPriceCents?: number;
  unitPriceCents?: number;
  unitPrice?: number;
  requestedStoreId?: string;
  searchStoreId?: string;
  detailStoreId?: string;
  searchLocation?: WalmartResponseLocation;
  detailLocation?: WalmartResponseLocation;
  searchStoreMatched?: boolean;
  detailStoreMatched?: boolean;
  fulfillment: WalmartFulfillmentType[];
  sellerType: WalmartSellerType;
  localPriceEligible: boolean;
  localPriceVerified: boolean;
  verifiedFulfillmentMode?: Exclude<WalmartFulfillmentType, "in_store">;
  checkedAt?: string;
}

export interface WalmartProduct extends RetailProductCore {
  retailer?: "walmart";
  priceProvenance?: WalmartPriceProvenance;
  dataSource?: "decodo" | "scrapingbee" | "openwebninja" | "serpapi" | "mock";
}

export type TargetSellerType = "target" | "marketplace" | "unknown";
export type TargetPriceSource = "target_search" | "target_product";
export type TargetPriceLabel =
  | "Verified exact-store price"
  | "Localized price estimate"
  | "Price estimate";

export interface TargetPriceProvenance extends RetailPriceTrust {
  retailer: "target";
  priceSource: TargetPriceSource;
  sellerType: TargetSellerType;
  searchPriceCents?: number;
  productDetailPriceCents?: number;
}

export interface TargetProduct extends RetailProductCore {
  retailer: "target";
  productId: string;
  priceProvenance: TargetPriceProvenance;
  dataSource: "decodo" | "redcircle" | "parsebot";
  identityVerified: boolean;
  availabilityStatus: Exclude<RetailAvailabilityStatus, "likely_available">;
  priceLabel: TargetPriceLabel;
  /** Target browser cart automation is deliberately not implemented. */
  cartEligible: false;
}

export interface KrogerPriceProvenance extends RetailPriceTrust {
  retailer: "kroger";
  priceSource: "kroger_location_product";
  regularPriceCents?: number;
  promoPriceCents?: number;
  locationId: string;
  locationName?: string;
  chain?: string;
}

/** A Kroger product returned for a specific official Kroger location. */
export interface KrogerProduct extends RetailProductCore {
  retailer: "kroger";
  productId: string;
  upc: string;
  priceProvenance: KrogerPriceProvenance;
  dataSource: "kroger_public_api";
  identityVerified: true;
  availabilityStatus: RetailAvailabilityStatus;
  cartEligible: boolean;
}

/** Strictly discriminated shape for new retailer-neutral consumers. */
export type RetailProduct =
  | (WalmartProduct & { retailer: "walmart" })
  | TargetProduct
  | KrogerProduct;

export interface WalmartCandidateDiagnostic {
  title: string;
  brand?: string;
  productId?: string;
  itemId?: string;
  seller?: string;
  sellerType: WalmartSellerType;
  currentPrice?: number;
  regularPrice?: number;
  salePrice?: number;
  unitPrice?: number;
  unitPriceBasis?: WalmartProduct["reportedUnitBasis"];
  fulfillment: WalmartFulfillmentType[];
  storeId?: string;
  priceSource?: WalmartPriceSource;
  rejectionReason?: string;
}

export type Confidence = "high" | "medium" | "low";

export type RetailMatchResolution =
  | "matched"
  | "matched_check_availability"
  | "multi_package_fulfillment"
  | "substitute_available"
  | "needs_choice"
  | "truly_unavailable";

/** Fulfillment belongs to a request/candidate pair, never to the catalog product itself. */
export interface RetailPackageFulfillment {
  kind: "single_package" | "multi_package" | "variable_weight";
  cartQuantity: number;
  packageCount: number;
  requestedBaseAmount?: number;
  suppliedBaseAmount?: number;
  baseUnit?: "oz" | "fl oz" | "each";
  overageBaseAmount?: number;
  overagePercent?: number;
  label: string;
  approvalRequired: boolean;
  recoveredFromStrictNoMatch?: boolean;
}

export interface RankedProduct extends WalmartProduct {
  score: number;
  confidence: Confidence;
  unitPrice?: number;
  unitLabel?: string;
  comparablePrice: number;
  matchedTerms: string[];
  reasons: string[];
}

export type RankedTargetProduct = TargetProduct & {
  score: number;
  confidence: Confidence;
  unitPrice?: number;
  unitLabel?: string;
  comparablePrice: number;
  matchedTerms: string[];
  reasons: string[];
};

export type RankedKrogerProduct = KrogerProduct & {
  score: number;
  confidence: Confidence;
  unitPrice?: number;
  unitLabel?: string;
  comparablePrice: number;
  matchedTerms: string[];
  reasons: string[];
};

export interface RetailMatchResult<TProduct extends RetailProductCore> {
  retailer: Retailer;
  requestedItem: string;
  recommended: TProduct | null;
  alternatives: TProduct[];
  assumptions?: string[];
  confidence: Confidence;
  status: "matched" | "review" | "no_match";
  resolution?: RetailMatchResolution;
  fulfillment?: RetailPackageFulfillment;
  explanation: string;
  clarification?: string;
  verifiedAt?: string;
  error?: string;
}

export interface TargetMatchResult extends RetailMatchResult<RankedTargetProduct> {
  retailer: "target";
}

export interface KrogerMatchResult extends RetailMatchResult<RankedKrogerProduct> {
  retailer: "kroger";
}

export interface ProductFeedbackOffer { upc: string; productId: string; title: string; package: string; canChoose: boolean }
export interface ProductFeedback { receipt: string; offers: ProductFeedbackOffer[] }

export interface KrogerSearchItemStreamEvent {
  type: "item";
  retailer: "kroger";
  phase: "search" | "verification";
  index: number;
  mode: "live";
  checkedAt: string;
  cartAutomation: {
    enabled: true;
    requiresCustomerConnection: true;
  } | {
    enabled: false;
    reason: string;
  };
  result: KrogerMatchResult;
  /** Web-only ephemeral evidence, never part of a saved match/snapshot. */
  correction?: ProductFeedback;
  diagnostics: {
    searchResultCount: number;
    selectedProductId?: string;
    verificationStatus: "verified" | "needs_review" | "no_verified_match";
    locationId: string;
    rejectionReason?: string;
  };
}

export interface KrogerSearchPerformanceStreamEvent {
  type: "performance";
  retailer: "kroger";
  mode: "live";
  checkedAt: string;
  comparisonReceipt?: {
    comparisonId: string;
    locationId: string;
    retailerBanner: string;
    completeness: "COMPLETE" | "INCOMPLETE";
    basketDigest: string;
    persisted: true;
  };
  performance: SearchPerformanceDiagnostics;
}

export type KrogerSearchStreamEvent =
  | KrogerSearchItemStreamEvent
  | KrogerSearchPerformanceStreamEvent;

export interface TargetCartAutomationPolicy {
  enabled: false;
  reason: string;
}

export interface TargetSearchItemStreamEvent {
  type: "item";
  retailer: "target";
  phase: "search" | "verification";
  index: number;
  mode: "live";
  checkedAt: string;
  cartAutomation: TargetCartAutomationPolicy;
  result: TargetMatchResult;
  diagnostics: {
    searchResultCount: number;
    selectedProductId?: string;
    verificationStatus: "verified" | "localized_estimate" | "needs_review" | "no_verified_match";
    rejectionReason?: string;
  };
}

export interface MatchResult {
  requestedItem: string;
  recommended: RankedProduct | null;
  alternatives: RankedProduct[];
  assumptions?: string[];
  confidence: Confidence;
  status: "matched" | "review" | "no_match";
  resolution?: RetailMatchResolution;
  fulfillment?: RetailPackageFulfillment;
  explanation: string;
  clarification?: string;
  verifiedAt?: string;
  error?: string;
}

export interface SearchItemStreamEvent {
  type: "item";
  phase: "search" | "verification";
  index: number;
  mode: "live" | "demo";
  checkedAt: string;
  result: MatchResult;
  diagnostics?: {
    searchResultCount: number;
    selectedProductId?: string;
    verificationStatus: "verified" | "best_reasonable_match" | "needs_review" | "no_verified_match";
    rejectionReason?: string;
    candidates?: WalmartCandidateDiagnostic[];
  };
}

export interface SearchPerformanceDiagnostics {
  totalDurationMs: number;
  cacheHits: number;
  searchApiCalls: number;
  productApiCalls: number;
  deduplicatedRequests: number;
  upstreamCacheUsed: "yes" | "no" | "unknown" | "local cache only";
  outcomeCounts?: {
    requestedItems: number;
    matchedAutomatically: number;
    multiPackageFulfilled: number;
    shopperChoiceRequired: number;
    trulyUnavailable: number;
  };
  items: Array<{
    index: number;
    item: string;
    searchDurationMs: number;
    verificationDurationMs: number;
    totalDurationMs: number;
  }>;
}

export interface SearchPerformanceStreamEvent {
  type: "performance";
  mode: "live" | "demo";
  checkedAt: string;
  performance: SearchPerformanceDiagnostics;
}

export interface TargetSearchPerformanceStreamEvent {
  type: "performance";
  retailer: "target";
  mode: "live";
  checkedAt: string;
  cartAutomation: TargetCartAutomationPolicy;
  performance: SearchPerformanceDiagnostics;
}

export type TargetSearchStreamEvent =
  | TargetSearchItemStreamEvent
  | TargetSearchPerformanceStreamEvent;

export type SearchStreamEvent = SearchItemStreamEvent | SearchPerformanceStreamEvent;
