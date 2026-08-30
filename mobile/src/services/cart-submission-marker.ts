import type { KrogerCartComparisonIdentity } from "./kroger-handoff-api";

const TRUSTED_KROGER_HOSTS = new Set([
  "www.kroger.com",
  "www.ralphs.com",
  "www.fredmeyer.com",
  "www.kingsoopers.com",
  "www.frysfood.com",
  "www.smithsfoodanddrug.com",
  "www.qfc.com",
  "www.dillons.com",
  "www.harristeeter.com",
  "www.marianos.com",
  "www.picknsave.com",
  "www.food4less.com",
  "www.citymarket.com",
  "www.bakersplus.com",
  "www.foodsco.net",
  "www.gerbes.com",
  "www.jaycfoods.com",
  "www.metromarket.net",
  "www.pay-less.com",
  "www.rulerfoods.com",
]);

export type KrogerCartSubmissionPhase =
  | "SUBMITTING"
  | "CONFIRMED"
  | "OUTCOME_UNKNOWN";

export interface KrogerCartSubmissionMarker extends KrogerCartComparisonIdentity {
  schemaVersion: 1;
  retailer: "kroger";
  phase: KrogerCartSubmissionPhase;
  updatedAt: string;
  message?: string;
  handoffUrl?: string;
  reviewUrl?: string;
}

function validIdentity(value: Partial<KrogerCartSubmissionMarker>) {
  return typeof value.comparisonId === "string"
    && /^[A-Za-z0-9_-]{16,128}$/.test(value.comparisonId)
    && typeof value.locationId === "string"
    && /^[A-Za-z0-9_-]{1,64}$/.test(value.locationId)
    && typeof value.retailerBanner === "string"
    && value.retailerBanner.trim().length > 0
    && value.retailerBanner.length <= 80;
}

export function isTrustedKrogerCartUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return isTrustedKrogerRetailerUrl(value)
      && url.pathname.replace(/\/+$/, "") === "/cart"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function isTrustedKrogerRetailerUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && TRUSTED_KROGER_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function parseKrogerCartSubmissionMarker(
  value: string,
): KrogerCartSubmissionMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const marker = parsed as Partial<KrogerCartSubmissionMarker>;
  if (
    marker.schemaVersion !== 1
    || marker.retailer !== "kroger"
    || !validIdentity(marker)
    || !["SUBMITTING", "CONFIRMED", "OUTCOME_UNKNOWN"].includes(marker.phase ?? "")
    || typeof marker.updatedAt !== "string"
    || Number.isNaN(new Date(marker.updatedAt).valueOf())
  ) return null;
  // Keep a valid submission phase even if optional display metadata was
  // corrupted. Dropping the whole marker could expose an unsafe retry; URLs
  // are independently allowlisted before they can become a CTA.
  return {
    schemaVersion: 1,
    retailer: "kroger",
    comparisonId: marker.comparisonId!,
    locationId: marker.locationId!,
    retailerBanner: marker.retailerBanner!,
    phase: marker.phase!,
    updatedAt: marker.updatedAt,
    ...(typeof marker.message === "string" && marker.message.length <= 500
      ? { message: marker.message }
      : {}),
    ...(isTrustedKrogerCartUrl(marker.handoffUrl) ? { handoffUrl: marker.handoffUrl } : {}),
    ...(isTrustedKrogerCartUrl(marker.reviewUrl) ? { reviewUrl: marker.reviewUrl } : {}),
  } as KrogerCartSubmissionMarker;
}
