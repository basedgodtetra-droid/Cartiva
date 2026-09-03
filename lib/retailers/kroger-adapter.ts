import {
  AvailabilityStatus,
  HandoffCapability,
  summarizeBasket,
} from "@/packages/shared/src";
import { rankKrogerProducts } from "@/lib/kroger-products";
import {
  findKrogerLocations,
  getKrogerLocation,
  isValidKrogerLocationId,
  krogerCartUrl,
  krogerShoppingUrl,
  searchKrogerProducts,
} from "@/lib/kroger-provider";
import type {
  KrogerLocation,
  KrogerLocationsResponse,
  KrogerSearchResponse,
} from "@/lib/kroger-provider";
import type { ProductConstraint } from "@/lib/product-facets";
import type { ProductIntent } from "@/lib/product-search-intent";
import type { KrogerMatchResult, KrogerProduct } from "@/lib/types";
import type { RetailerAdapter } from "./retailer-adapter";

export interface KrogerVerificationOptions {
  constraints?: ProductConstraint[];
  cartQuantity?: number;
  intent?: ProductIntent;
  preferredIdentity?: {
    productId?: string;
    title?: string;
  };
}

/**
 * The live Kroger vertical. This is deliberately a thin delegation layer:
 * OAuth, official endpoint calls, caching, normalization, and strict matching
 * remain in the already-tested Kroger provider and intelligence modules.
 */
type KrogerRetailerAdapter = RetailerAdapter<
  KrogerLocation,
  KrogerProduct,
  KrogerLocationsResponse,
  KrogerSearchResponse,
  KrogerMatchResult,
  KrogerVerificationOptions
>;

const krogerAdapterImplementation: KrogerRetailerAdapter = {
  id: "kroger",
  label: "Kroger",
  status: "ACTIVE",
  read: Object.freeze({ locations: true, productSearch: true }),

  isValidLocationId(value) {
    return isValidKrogerLocationId(value);
  },
  findLocations(zipCode) {
    return findKrogerLocations(zipCode);
  },
  verifyLocation(locationId) {
    return getKrogerLocation(locationId);
  },
  searchProducts(query, context) {
    return searchKrogerProducts(query, context);
  },
  verifyCandidates(request, candidates, options) {
    return rankKrogerProducts(
      request,
      candidates,
      options.constraints ?? [],
      options.preferredIdentity,
      {
        cartQuantity: options.cartQuantity,
        intent: options.intent,
      },
    );
  },
  normalizeAvailability(evidence) {
    if (evidence === "in_stock") return AvailabilityStatus.VERIFIED_IN_STOCK;
    if (evidence === "likely_available") return AvailabilityStatus.LIKELY_AVAILABLE;
    if (evidence === "out_of_stock") return AvailabilityStatus.OUT_OF_STOCK;
    return AvailabilityStatus.UNKNOWN;
  },
  summarizeBasket,
  getHandoffCapabilities(boundary) {
    if (boundary === "ANONYMOUS_MOBILE") {
      return {
        mode: HandoffCapability.SHOPPING_PAGE_ONLY,
        cartTransferSupported: false,
        requiresRetailerCheckout: true,
      };
    }
    return {
      mode: HandoffCapability.CART_TRANSFER_SUPPORTED,
      cartTransferSupported: true,
      requiresRetailerCheckout: true,
      requiresCustomerAuthorization: true,
      cartApiLocationBound: false,
      requiresStoreConfirmation: true,
    };
  },
  getHandoffUrl(boundary, location) {
    return boundary === "ANONYMOUS_MOBILE"
      ? krogerShoppingUrl(location?.chain)
      : krogerCartUrl(location?.chain);
  },
};

export const krogerAdapter = Object.freeze(krogerAdapterImplementation);
