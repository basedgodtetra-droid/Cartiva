import type {
  CartBuildItem,
  CartBuildState,
  WalmartPageContext,
  WalmartStoreOption,
} from "./types.js";

export type BackgroundRequest =
  | { type: "CARTIVA_GET_PAGE_CONTEXT" }
  | { type: "CARTIVA_GET_CART_BUILD" }
  | { type: "CARTIVA_FIND_NEARBY_PICKUP_STORES"; zipCode: string; tabId?: number }
  | { type: "CARTIVA_SELECT_PICKUP_STORE"; store: WalmartStoreOption; tabId?: number }
  | { type: "CARTIVA_APPLY_STORE_AND_RESUME"; store: WalmartStoreOption }
  | {
      type: "CARTIVA_START_CART_BUILD";
      retailer?: "walmart" | "target";
      confirmed: true;
      items: Omit<CartBuildItem, "status">[];
      storeId?: string;
      storeName?: string;
      storeAddress?: string;
      zip?: string;
      fulfillmentMode: "pickup" | "delivery" | "shipping";
    }
  | { type: "CARTIVA_RESUME_CART_BUILD" }
  | { type: "CARTIVA_CANCEL_CART_BUILD" }
  | { type: "CARTIVA_OPEN_WALMART" }
  | { type: "CARTIVA_OPEN_WALMART_CART" }
  | { type: "CARTIVA_OPEN_TARGET_CART" }
  | { type: "CARTIVA_OPEN_KROGER_URL"; url: string };

export type ContentRequest =
  | { type: "CARTIVA_WALMART_GET_CONTEXT" }
  | { type: "CARTIVA_WALMART_GET_PICKUP_STORES" }
  | { type: "CARTIVA_WALMART_SELECT_PICKUP_STORE"; storeId: string }
  | { type: "CARTIVA_WALMART_SET_FULFILLMENT"; mode: "pickup" | "delivery" }
  | {
      type: "CARTIVA_WALMART_ADD_PRODUCT";
      itemId: string;
      productId?: string;
      productTitle: string;
      quantity: number;
    }
  | {
      type: "CARTIVA_WALMART_VERIFY_MANUAL_ADD";
      baselineCartCount?: number;
      productTitle: string;
      expectedQuantity: number;
    }
  | {
      type: "CARTIVA_TARGET_ADD_PRODUCT";
      tcin: string;
      productTitle: string;
      quantity: number;
      fulfillmentMode: "pickup" | "delivery" | "shipping";
      storeId?: string;
    }
  | {
      type: "CARTIVA_TARGET_VERIFY_MANUAL_ADD";
      baselineCartCount?: number;
      productTitle: string;
      expectedQuantity: number;
    };

export type ContentAddResult = {
  status: "added" | "needs_choice" | "unavailable" | "failed";
  message: string;
  baselineCartCount?: number;
};

export type ContentStoreSelectionResult = {
  store: WalmartStoreOption;
  selected: boolean;
  message: string;
};

export type ContentStoreLookupResult = {
  stores: WalmartStoreOption[];
};

export type RuntimeBroadcast =
  | { type: "CARTIVA_CART_BUILD_UPDATED"; state: CartBuildState }
  | { type: "CARTIVA_PAGE_CONTEXT_UPDATED"; context: WalmartPageContext };

type UnknownRecord = Record<string, unknown>;

export interface BackgroundSenderLike {
  id?: string;
  url?: string;
  tab?: unknown;
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]) {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function optionalString(value: unknown, maximum: number, pattern?: RegExp) {
  return value === undefined || (
    typeof value === "string"
    && value.length <= maximum
    && (!pattern || pattern.test(value))
  );
}

function optionalTabId(value: unknown) {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 0);
}

function isStoreOption(value: unknown): value is WalmartStoreOption {
  const store = record(value);
  return Boolean(store)
    && hasOnlyKeys(store!, ["id", "name", "address", "zip"])
    && typeof store!.id === "string"
    && /^\d{1,8}$/.test(store!.id)
    && typeof store!.name === "string"
    && store!.name.trim().length > 0
    && store!.name.length <= 200
    && typeof store!.address === "string"
    && store!.address.trim().length > 0
    && store!.address.length <= 300
    && typeof store!.zip === "string"
    && /^\d{5}$/.test(store!.zip);
}

function isCartBuildRequestItem(value: unknown) {
  const item = record(value);
  if (!item || !hasOnlyKeys(item, [
    "id",
    "requestedText",
    "productTitle",
    "itemId",
    "productId",
    "productUrl",
    "priceCents",
    "checkedAt",
    "quantity",
  ])) return false;

  return typeof item.id === "string"
    && item.id.trim().length > 0
    && item.id.length <= 160
    && typeof item.requestedText === "string"
    && item.requestedText.trim().length > 0
    && item.requestedText.length <= 500
    && typeof item.productTitle === "string"
    && item.productTitle.trim().length > 0
    && item.productTitle.length <= 500
    && typeof item.itemId === "string"
    && /^\d{6,20}$/.test(item.itemId)
    && optionalString(item.productId, 100, /^[A-Za-z0-9_-]{1,100}$/)
    && typeof item.productUrl === "string"
    && item.productUrl.length <= 2_000
    && typeof item.checkedAt === "string"
    && item.checkedAt.length <= 80
    && Number.isInteger(item.priceCents)
    && (item.priceCents as number) > 0
    && Number.isInteger(item.quantity)
    && (item.quantity as number) >= 1
    && (item.quantity as number) <= 24;
}

function isStartCartBuildRequest(message: UnknownRecord) {
  if (!hasOnlyKeys(message, [
    "type",
    "retailer",
    "confirmed",
    "items",
    "storeId",
    "storeName",
    "storeAddress",
    "zip",
    "fulfillmentMode",
  ])) return false;
  if (message.retailer !== undefined && message.retailer !== "walmart" && message.retailer !== "target") {
    return false;
  }
  if (message.confirmed !== true || !Array.isArray(message.items)
    || message.items.length < 1 || message.items.length > 24
    || !message.items.every(isCartBuildRequestItem)) return false;
  return optionalString(message.storeId, 32)
    && optionalString(message.storeName, 200)
    && optionalString(message.storeAddress, 300)
    && optionalString(message.zip, 5, /^\d{5}$/)
    && (message.fulfillmentMode === "pickup"
      || message.fulfillmentMode === "delivery"
      || message.fulfillmentMode === "shipping");
}

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  const message = record(value);
  if (!message || typeof message.type !== "string") return false;
  switch (message.type) {
    case "CARTIVA_GET_PAGE_CONTEXT":
    case "CARTIVA_GET_CART_BUILD":
    case "CARTIVA_RESUME_CART_BUILD":
    case "CARTIVA_CANCEL_CART_BUILD":
    case "CARTIVA_OPEN_WALMART":
    case "CARTIVA_OPEN_WALMART_CART":
    case "CARTIVA_OPEN_TARGET_CART":
      return hasOnlyKeys(message, ["type"]);
    case "CARTIVA_FIND_NEARBY_PICKUP_STORES":
      return hasOnlyKeys(message, ["type", "zipCode", "tabId"])
        && typeof message.zipCode === "string"
        && /^\d{5}$/.test(message.zipCode)
        && optionalTabId(message.tabId);
    case "CARTIVA_SELECT_PICKUP_STORE":
      return hasOnlyKeys(message, ["type", "store", "tabId"])
        && isStoreOption(message.store)
        && optionalTabId(message.tabId);
    case "CARTIVA_APPLY_STORE_AND_RESUME":
      return hasOnlyKeys(message, ["type", "store"])
        && isStoreOption(message.store);
    case "CARTIVA_START_CART_BUILD":
      return isStartCartBuildRequest(message);
    case "CARTIVA_OPEN_KROGER_URL":
      return hasOnlyKeys(message, ["type", "url"])
        && typeof message.url === "string"
        && message.url.length > 0
        && message.url.length <= 2_000;
    default:
      return false;
  }
}

export function isTrustedSidePanelSender(sender: BackgroundSenderLike, extensionId: string) {
  if (!/^[a-p]{32}$/.test(extensionId) || sender.id !== extensionId || sender.tab !== undefined) {
    return false;
  }
  if (typeof sender.url !== "string") return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "chrome-extension:"
      && url.hostname === extensionId
      && url.pathname === "/sidepanel.html"
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}
