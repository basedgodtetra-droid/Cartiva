import { krogerAdapter } from "./kroger-adapter";
import type { ActiveRetailerId } from "./retailer-adapter";
import { mobileKrogerCapabilityStatus } from "../kroger-mobile-auth";

/** Registered means live. Future retailers are added only when their adapter is real. */
export const activeRetailerAdapters = Object.freeze([krogerAdapter] as const);

export function getActiveRetailerAdapter(id: ActiveRetailerId) {
  const adapter = activeRetailerAdapters.find((candidate) => candidate.id === id);
  if (!adapter) throw new Error(`No active retailer adapter is registered for ${id}.`);
  return adapter;
}

export function anonymousMobileRetailerCapabilities() {
  const krogerMobile = mobileKrogerCapabilityStatus();
  return activeRetailerAdapters.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    status: adapter.status,
    read: adapter.read,
    handoff: adapter.id === "kroger" && krogerMobile.configured
      ? adapter.getHandoffCapabilities("TEMPORARY_MOBILE_SESSION")
      : {
          ...adapter.getHandoffCapabilities("ANONYMOUS_MOBILE"),
          reason: krogerMobile.reason,
        },
  }));
}
