export type FulfillmentMode = "pickup" | "delivery" | "shipping" | "unknown";
export type Retailer = "walmart" | "target" | "kroger";
export type ShoppingMode = "retailer" | "compare";

export interface WalmartPageContext {
  onWalmart: boolean;
  tabId?: number;
  storeId?: string;
  storeName?: string;
  address?: string;
  zip?: string;
  fulfillmentMode: FulfillmentMode;
  pageType?: "home" | "search" | "product" | "cart" | "other";
}

export interface WalmartStoreOption {
  id: string;
  name: string;
  address: string;
  zip: string;
}

export interface WalmartStoreLookupResult {
  zipCode: string;
  stores: WalmartStoreOption[];
}

export interface KrogerStoreOption {
  id: string;
  name: string;
  chain: string;
  address: string;
  zip: string;
}

export interface KrogerStoreLookupResult {
  zipCode: string;
  stores: KrogerStoreOption[];
}

export interface WalmartNearbyStoreResult {
  zipCode: string;
  stores: WalmartStoreOption[];
  tabId?: number;
}

export interface WalmartStoreApplyResult {
  store: WalmartStoreOption;
  pickupConfirmed: boolean;
  message: string;
  context?: WalmartPageContext;
}

export interface ExplicitRequestDetails {
  brand?: string;
  size?: string;
  packCount?: number;
}

export interface ParsedListItem extends ExplicitRequestDetails {
  id: string;
  text: string;
  normalizedText: string;
  quantity: number;
  preferredProductId?: string;
  preferredItemId?: string;
  preferredTitle?: string;
}

export interface WalmartProductSuggestion {
  title: string;
  productId?: string;
  itemId?: string;
  brand?: string;
  brandSource?: "api" | "title";
  flavor?: string;
  format?: string;
  fulfillment?: Array<Exclude<FulfillmentMode, "unknown"> | "in_store">;
  price: number;
  packageSize?: string;
}

export interface WalmartSearchIdea {
  text: string;
  evidenceCount?: number;
}

export interface WalmartSuggestionResult {
  query: string;
  mode: "live" | "demo";
  searchIdeas: WalmartSearchIdea[];
  suggestions: WalmartProductSuggestion[];
}

export interface PreferredProductSelection {
  preferredProductId?: string;
  preferredItemId?: string;
  preferredTitle: string;
}

export interface ProductMeasurement {
  amount: number;
  unit: "oz" | "lb" | "fl oz" | "count";
  kind: "weight" | "volume" | "count";
  baseAmount: number;
  baseUnit: "oz" | "fl oz" | "each";
  packCount?: number;
  perPackageAmount?: number;
  label: string;
}

export interface ExtensionProduct {
  retailer?: Retailer;
  id: string;
  productId?: string;
  itemId?: string;
  upc?: string;
  title: string;
  brand?: string;
  price: number;
  priceCents?: number;
  link: string;
  linkType?: "product" | "search";
  productPageUnavailable?: boolean;
  dataSource?: "openwebninja" | "scrapingbee" | "serpapi" | "decodo" | "redcircle" | "parsebot" | "kroger_public_api" | "mock";
  size?: ProductMeasurement;
  unitPrice?: number;
  unitLabel?: string;
  inStock: boolean;
  checkedAt?: string;
  score?: number;
  verification?: "verified" | "unverified" | "suspicious";
  priceProvenance?: {
    retailer?: Retailer;
    priceSource?: string;
    fulfillment?: Array<FulfillmentMode | "in_store">;
    localPriceEligible?: boolean;
    localPriceVerified?: boolean;
    priceScope?: "exact_store" | "localized" | "estimated";
    verifiedFulfillmentMode?: Exclude<FulfillmentMode, "unknown">;
    sellerType?: "walmart" | "target" | "kroger" | "marketplace" | "unknown";
    requestedStoreId?: string;
    searchStoreId?: string;
    detailStoreId?: string;
    searchStoreMatched?: boolean;
    detailStoreMatched?: boolean;
    checkedAt?: string;
    priceReliability?: "verified" | "localized_estimate" | "unreliable";
    exactStoreVerified?: boolean;
    regularPriceCents?: number;
    promoPriceCents?: number;
    promoUnconditional?: boolean;
    location?: {
      requestedStoreId?: string;
      observedStoreId?: string;
      requestedPostalCode?: string;
      observedPostalCode?: string;
      responseProvesLocation?: boolean;
      storeMatched?: boolean;
      postalCodeMatched?: boolean;
    };
  };
  priceLabel?: "Verified exact-store price" | "Localized price estimate" | "Price estimate";
  identityVerified?: boolean;
  availabilityStatus?: "in_stock" | "out_of_stock" | "unknown";
  cartEligible?: boolean;
}

export type MatchStatus = "searching" | "matched" | "needs_review" | "no_match" | "api_error";
export type CartItemStatus =
  | "ready"
  | "adding"
  | "added"
  | "needs_choice"
  | "unavailable"
  | "failed"
  | "skipped";

export interface PreparedItem {
  id: string;
  request: ParsedListItem;
  matchStatus: MatchStatus;
  product?: ExtensionProduct;
  alternatives: ExtensionProduct[];
  explanation?: string;
  assumptions?: string[];
  checkedAt?: string;
  dataMode?: "live" | "demo";
  cartStatus: CartItemStatus;
  cartMessage?: string;
  cartErrorCode?: string;
  cartRetrySafe?: boolean;
  estimatedByWeight?: boolean;
  retailer?: Retailer;
}

export interface ExtensionSettings {
  backendBaseUrl: string;
  retailer?: Retailer;
  pickupZip?: string;
  selectedStore?: WalmartStoreOption;
  targetZip?: string;
  targetStoreId?: string;
  targetFulfillmentMode?: Exclude<FulfillmentMode, "unknown">;
  krogerZip?: string;
  krogerStore?: KrogerStoreOption;
  krogerFulfillmentMode?: Exclude<FulfillmentMode, "unknown">;
  krogerCartOperationId?: string;
  krogerCartUrl?: string;
  /** Legacy developer fallback retained only for stored version-1 state migration. */
  storeIdOverride?: string;
  fulfillmentModeOverride?: Exclude<FulfillmentMode, "unknown">;
}

export interface ExtensionAppState {
  version: 1;
  shoppingMode?: ShoppingMode;
  listText: string;
  parsedItems: ParsedListItem[];
  preparedItems: PreparedItem[];
  preferredProducts: Record<string, PreferredProductSelection>;
  pageContext: WalmartPageContext;
  settings: ExtensionSettings;
  comparison?: ComparisonSearchState;
  lastPreparedAt?: string;
}

export type ComparisonRunStatus = "idle" | "searching" | "complete" | "error";

export interface ComparisonRetailerState {
  status: ComparisonRunStatus;
  items: PreparedItem[];
  contextSignature: string;
  error?: string;
  updatedAt?: string;
}

export interface ComparisonSearchState {
  version: 1;
  status: ComparisonRunStatus;
  listSignature: string;
  contextSignature: string;
  requestedCount: number;
  startedAt?: string;
  updatedAt?: string;
  retailers: Record<Retailer, ComparisonRetailerState>;
}

export interface CartBuildItem {
  id: string;
  requestedText: string;
  productTitle: string;
  itemId: string;
  productId?: string;
  productUrl: string;
  priceCents: number;
  checkedAt: string;
  quantity: number;
  status: CartItemStatus;
  message?: string;
  baselineCartCount?: number;
  choiceRetryCount?: number;
}

export type CartBuildStatus = "idle" | "running" | "paused" | "complete" | "cancelled";

export interface CartBuildState {
  version: 1;
  id: string;
  status: CartBuildStatus;
  confirmed: boolean;
  cursor: number;
  items: CartBuildItem[];
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  pauseReason?: string;
  pauseKind?: "context" | "item_choice" | "recovery";
  /** Missing on saved v1 builds means Walmart. */
  retailer?: Retailer;
  walmartTabId?: number;
  targetTabId?: number;
  storeId?: string;
  storeName?: string;
  storeAddress?: string;
  zip?: string;
  fulfillmentMode: FulfillmentMode;
}

export interface BackendItemResult {
  item: PreparedItem;
  phase: "search" | "verification" | "error";
}
