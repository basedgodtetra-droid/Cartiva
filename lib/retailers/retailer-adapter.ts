import type {
  AvailabilityStatus,
  BasketLineSummaryInput,
  BasketSummary,
  HandoffCapability,
} from "@/packages/shared/src";
import type { RetailFulfillmentMode } from "@/lib/types";

/** Only retailers with a live, official data path belong in this union. */
export type ActiveRetailerId = "kroger";

export type RetailerAdapterStatus = "ACTIVE";
export type RetailerClientBoundary =
  | "ANONYMOUS_MOBILE"
  | "TEMPORARY_MOBILE_SESSION"
  | "TRUSTED_LOCAL_SERVER";

export interface RetailerLocation {
  locationId: string;
  name: string;
  chain: string;
  address: {
    addressLine1: string;
    city: string;
    state: string;
    zipCode: string;
  };
}

export interface RetailerSearchContext {
  locationId: string;
  /** Product searches may run only after the official retailer echoes this ID. */
  locationVerified: true;
  locationName?: string;
  chain?: string;
  fulfillmentMode: RetailFulfillmentMode;
}

export interface RetailerHandoffCapabilities {
  mode: HandoffCapability;
  cartTransferSupported: boolean;
  requiresRetailerCheckout: true;
  requiresCustomerAuthorization?: boolean;
  /** Kroger's public cart/add request has no locationId field. */
  cartApiLocationBound?: boolean;
  requiresStoreConfirmation?: boolean;
}

export interface RetailerAdapter<
  TLocation extends RetailerLocation,
  TProduct,
  TLocationsResult,
  TSearchResult,
  TMatchResult,
  TVerificationOptions,
> {
  readonly id: ActiveRetailerId;
  readonly label: string;
  readonly status: RetailerAdapterStatus;
  readonly read: {
    readonly locations: true;
    readonly productSearch: true;
  };

  isValidLocationId(value: string): boolean;
  findLocations(zipCode: string): Promise<TLocationsResult>;
  verifyLocation(locationId: string): Promise<TLocation>;

  /** Flexible discovery. Strict shopper-constraint verification stays separate. */
  searchProducts(
    query: string,
    context: RetailerSearchContext,
  ): Promise<TSearchResult>;
  verifyCandidates(
    request: string,
    candidates: TProduct[],
    options: TVerificationOptions,
  ): TMatchResult;

  /** Missing retailer evidence must normalize to UNKNOWN, never out of stock. */
  normalizeAvailability(evidence: unknown): AvailabilityStatus;
  summarizeBasket(lines: readonly BasketLineSummaryInput[]): BasketSummary;
  getHandoffCapabilities(
    boundary: RetailerClientBoundary,
  ): RetailerHandoffCapabilities;
  getHandoffUrl(
    boundary: RetailerClientBoundary,
    location?: Pick<TLocation, "chain">,
  ): string;
}
