import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extensionRoot = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(`${extensionRoot}/manifest.json`, "utf8")) as {
  host_permissions: string[];
  content_scripts: Array<{ matches: string[]; js: string[] }>;
};
const background = readFileSync(`${extensionRoot}/src/background.ts`, "utf8");
const targetContent = readFileSync(`${extensionRoot}/src/target-content.ts`, "utf8");
const sidepanel = readFileSync(`${extensionRoot}/src/sidepanel.ts`, "utf8");

describe("Target cart automation wiring", () => {
  it("registers the Target helper only on Target's HTTPS origin", () => {
    expect(manifest.host_permissions).toContain("https://www.target.com/*");
    expect(manifest.content_scripts).toContainEqual({
      matches: ["https://www.target.com/*"],
      js: ["js/target-control-policy.js", "js/target-content.js"],
      run_at: "document_idle",
    });
  });

  it("keeps Target separate from Walmart while persisting progress", () => {
    expect(background).toContain("runTargetBuildLoop");
    expect(background).toContain('type: "CARTIVA_TARGET_ADD_PRODUCT"');
    expect(background).toContain("isValidTargetProductUrl(current.productUrl, current.itemId)");
    expect(background).toContain("storeId: state.storeId");
    expect(sidepanel).toContain("isTargetBuildEligible");
    expect(sidepanel).toContain("retailer: effectiveRetailer()");
  });

  it("selects visible fulfillment and exact pickup store before Add", () => {
    expect(targetContent.indexOf("selectFulfillment(fulfillmentMode)"))
      .toBeLessThan(targetContent.indexOf("waitForAddButton(tcin, exactTitle, fulfillmentMode)"));
    expect(targetContent).toContain("visiblePickupStoreMatches(storeId, storeElementId)");
    expect(targetContent).toContain('button[data-test=\'scheduledDeliveryButton\']');
    expect(targetContent).toContain("count >= beforeCount + expectedQuantity");
  });

  it("does not call undocumented Target services from the page helper", () => {
    expect(targetContent).not.toMatch(/fetch\s*\(|XMLHttpRequest|redsky|api\.target|graphql/i);
    expect(background).not.toMatch(/redsky|api\.target|graphql/i);
  });
});
