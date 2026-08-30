import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extensionRoot = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${extensionRoot}/public/sidepanel.html`, "utf8");
const css = readFileSync(`${extensionRoot}/public/sidepanel.css`, "utf8");
const sidepanelSource = readFileSync(`${extensionRoot}/src/sidepanel.ts`, "utf8");
const autoComparisonSource = readFileSync(`${extensionRoot}/src/auto-comparison.ts`, "utf8");
const manifest = JSON.parse(readFileSync(`${extensionRoot}/manifest.json`, "utf8")) as { version: string };
const packageJson = JSON.parse(readFileSync(`${extensionRoot}/package.json`, "utf8")) as { version: string };

describe("side-panel markup contract", () => {
  it("keeps every runtime element ID present exactly once", () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const runtimeIds = [...sidepanelSource.matchAll(/byId<[^>]+>\("([^"]+)"\)/g)]
      .map((match) => match[1]);

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of runtimeIds) {
      expect(ids, `missing #${id}`).toContain(id);
    }
    expect(html).toContain('id="prepare-list"');
    expect(html).toContain('class="button-label"');
  });

  it("retains the accessible store, typeahead, and result-scroll relationships", () => {
    expect(html).toMatch(/<details id="store-picker"[^>]*open>/);
    expect(html).toContain('for="pickup-zip"');
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/id="shopping-list"[^>]*role="combobox"/);
    expect(html).toMatch(/id="shopping-list"[^>]*aria-controls="grocery-suggestions"/);
    expect(html).toMatch(/id="grocery-suggestions"[^>]*role="listbox"[^>]*aria-label="Walmart products"/);
    expect(html).toMatch(/id="result-list"[^>]*role="region"[^>]*tabindex="0"/);
  });

  it("uses a progressive store, list, and cart flow", () => {
    expect(html).toContain('id="flow-location-indicator"');
    expect(html).toContain('id="flow-list-indicator"');
    expect(html).toContain('id="flow-results-indicator"');
    expect(html).toMatch(/id="list-step"[^>]*hidden/);
    expect(html).toMatch(/id="prepare-list"[^>]*hidden/);
    expect(html).toContain('<span class="button-label">Build my Walmart cart</span>');
    expect(sidepanelSource).toContain('type GuidedFlowStage = "location" | "list" | "results"');
    expect(sidepanelSource).toContain('document.body.dataset.flowStage = stage');
    expect(sidepanelSource).toContain('elements.prepareList.hidden = stage !== "list" || !hasList');
    expect(css).toContain('@keyframes flow-panel-reveal');
  });

  it("keeps product results image-free and retailer-safe", () => {
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toContain('id="choose-walmart"');
    expect(html).not.toContain('id="choose-target"');
    expect(html).not.toContain('id="choose-kroger"');
    expect(html).not.toContain('id="choose-compare"');
    expect(html).not.toMatch(/Albertsons|coupons|recipes|pantry/i);
    expect(sidepanelSource).toContain("walmartProductSuggestions(liveSuggestions, 6)");
    expect(sidepanelSource).not.toContain("result.searchIdeas");
    expect(sidepanelSource).toContain('if (effectiveRetailer() === "target")');
    expect(sidepanelSource).toContain("automaticCartBuildRetryAvailable = false");
    expect(sidepanelSource).toContain('added === 0 && !outcomeUnknown && eligible.length === 0');
    expect(sidepanelSource).toContain('krogerCartUrl = state.settings.krogerCartUrl ?? "https://www.kroger.com/cart"');
    expect(sidepanelSource).toContain('item.cartRetrySafe === false');
    expect(sidepanelSource).toContain('elements.connectKroger.disabled = krogerOAuthChecking || krogerCartPending');
  });

  it("keeps comparison search isolated from retailer-specific choices and cart writes", () => {
    expect(html).toContain('id="comparison-setup"');
    expect(html).toContain('id="comparison-results-section"');
    expect(html).toContain('id="comparison-edit-stores"');
    expect(sidepanelSource).toContain('if (isComparisonMode()) {\n    hideGrocerySuggestions();');
    expect(sidepanelSource).toContain('function comparisonParsedItems() {\n  return parseShoppingList(elements.shoppingList.value);');

    const comparisonPrepare = sidepanelSource.slice(
      sidepanelSource.indexOf("async function prepareComparisonList("),
      sidepanelSource.indexOf("async function prepareCurrentList()"),
    );
    expect(comparisonPrepare).toContain("comparisonParsedItems()");
    expect(comparisonPrepare).not.toContain("parseListWithPreferredProducts");
    expect(comparisonPrepare).not.toMatch(/startCartBuild|startKrogerCartBuild|openConfirmation|addKrogerCart/);

    const comparisonActivation = sidepanelSource.slice(
      sidepanelSource.indexOf("async function activateComparisonRetailer"),
      sidepanelSource.indexOf("function createComparisonBasketCard"),
    );
    expect(comparisonActivation).toContain("retailerResult.items.map");
    expect(comparisonActivation).toContain("const selectedContext = comparisonContexts()[retailer]");
    expect(comparisonActivation).toContain('selectedContext.fulfillmentMode === "delivery" ? "delivery" : "pickup"');
    expect(sidepanelSource).toContain("comparisonEditingStores = true;\n  cancelActivePreparation();");
    expect(sidepanelSource).toContain("function recoverComparisonSearchState");
    expect(sidepanelSource).toContain("This comparison was interrupted when Cartiva closed");
    expect(sidepanelSource).toContain('invalidatePreparedItems("The Cartiva backend changed');
    expect(sidepanelSource).toContain("invalidateComparison();");
  });

  it("uses one ZIP and a stable list without manual retailer or store controls", () => {
    expect(html).toContain('id="comparison-zip"');
    expect(html).toContain('id="comparison-walmart-status"');
    expect(html).toContain('id="comparison-target-status"');
    expect(html).toContain('id="comparison-kroger-status"');
    expect(html).toContain("ZIP estimate");
    expect(html).not.toContain('id="find-comparison-stores"');
    expect(html).not.toContain('id="comparison-walmart-store"');
    expect(html).not.toContain('id="comparison-kroger-store"');
    expect(html).not.toContain('id="comparison-target-store-id"');
    expect(html).not.toContain('id="comparison-continue"');
    expect(sidepanelSource).toContain('shoppingMode: "compare"');
    expect(sidepanelSource).toContain('target: { fulfillmentMode: "delivery", zip: state.settings.targetZip }');
    expect(sidepanelSource).toContain("scheduleComparisonZipLookup();");
    expect(sidepanelSource).toContain("scheduleAutomaticComparison();");
    expect(sidepanelSource).toContain("if (currentComparison()) return;");
    expect(sidepanelSource).toContain("storeLookupController?.abort();");
    expect(sidepanelSource).toContain('target: { fulfillmentMode: "delivery", zip: targetZip }');
    expect(autoComparisonSource).toContain("AUTO_COMPARE_ZIP_DEBOUNCE_MS = 400");
    expect(autoComparisonSource).toContain("AUTO_COMPARE_LIST_DEBOUNCE_MS = 1_400");
    expect(css).toMatch(/body\[data-shopping-mode="compare"\]\s+#prepare-list\s*\{[^}]*display:\s*none/s);
  });

  it("uses the compact accessible grass design and independent mini-scroll", () => {
    expect(css).toContain("--grass: #41b93c");
    expect(css).toContain("--grass-strong: #267a30");
    expect(css).toContain("--lime: #d7fa42");
    expect(css).toMatch(/\.app-header\s*\{[^}]*min-height:\s*56px/s);
    expect(css).toMatch(/\.result-list\s*\{[^}]*max-height:\s*clamp\(18rem, 55dvh, 36rem\)[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it("keeps critical text legible and prevents narrow-panel overflow", () => {
    expect(css).toMatch(/\.help-copy\s*\{[^}]*font-size:\s*0\.78rem/s);
    expect(css).toMatch(/\.requested-copy\s*>\s*strong\s*\{[^}]*font-size:\s*0\.9rem/s);
    expect(css).toMatch(/\.product-title\s*\{[^}]*font-size:\s*0\.9rem/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.summary-card\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
    expect(css).toMatch(/body\s*\{[^}]*overflow-x:\s*hidden/s);
  });

  it("keeps manifest and package versions aligned", () => {
    expect(manifest.version).toBe("0.6.0");
    expect(packageJson.version).toBe(manifest.version);
  });
});
