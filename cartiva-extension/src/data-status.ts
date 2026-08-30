import type { PreparedItem, Retailer } from "./types.js";

export type DataBadgeMode = "idle" | "demo" | "live" | "partial" | "error";

export function dataStatusFor(
  items: PreparedItem[],
  retailer: Retailer = "walmart",
): { mode: DataBadgeMode; label: string } {
  const retailerName = retailer === "target" ? "Target" : retailer === "kroger" ? "Kroger" : "Walmart";
  const hasDemo = items.some((item) => item.dataMode === "demo");
  const hasApiError = items.some((item) => item.matchStatus === "api_error");
  const hasLiveResult = items.some((item) =>
    item.dataMode === "live" && item.matchStatus !== "api_error");

  if (hasDemo) return { mode: "demo", label: "Demo data" };
  if (hasApiError && !hasLiveResult) {
    return { mode: "error", label: `${retailerName} data unavailable` };
  }
  if (hasApiError) return { mode: "partial", label: "Live data · some failed" };
  if (hasLiveResult) return { mode: "live", label: `Live ${retailerName} data` };
  return { mode: "idle", label: "Not checked" };
}
