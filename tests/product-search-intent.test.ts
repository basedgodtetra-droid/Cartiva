import { describe, expect, it } from "vitest";

import { extractMeasurement } from "@/lib/measurements";
import { rankProducts } from "@/lib/matching";
import { analyzeProductFacets, buildFacetSearchQuery } from "@/lib/product-facets";
import {
  explainDiscoveryFailure,
  isPlausibleDiscoveryCandidate,
  parseProductIntent,
  retrieveCandidatesProgressively,
  stripDiscoveryPackageTerms,
} from "@/lib/product-search-intent";
import type { WalmartProduct } from "@/lib/types";

function product(
  id: string,
  title: string,
  options: Partial<WalmartProduct> = {},
): WalmartProduct {
  return {
    id,
    title,
    price: 4.99,
    link: "https://www.walmart.com/ip/example/123",
    linkType: "product",
    inStock: true,
    sponsored: false,
    seller: "Walmart.com",
    size: extractMeasurement(title),
    ...options,
  };
}

function rankThroughServerIntent(request: string, candidates: WalmartProduct[]) {
  const facets = analyzeProductFacets(request);
  const matchingRequest = buildFacetSearchQuery(request, facets.constraints);
  const structuredRequest = analyzeProductFacets(matchingRequest);
  return rankProducts(matchingRequest, candidates, structuredRequest.constraints);
}

describe("retailer-neutral product discovery intent", () => {
  it.each([
    ["Whole Milk, 1 gallon", "Whole Milk"],
    ["Coke Zero 24 pack 12 oz cans", "Coke Zero"],
    ["Large brown eggs 18 count", "Large brown eggs"],
    ["white bread 20 oz", "white bread"],
    ["Plain Greek yogurt 32 oz", "Plain Greek yogurt"],
    ["Cheerios cereal 18 oz", "Cheerios cereal"],
    ["boneless skinless chicken breast 2 lb", "boneless skinless chicken breast"],
    ["Fuji apples 3 lb bag", "Fuji apples"],
    ["dish soap 24 fl oz", "dish soap"],
    ["shampoo 12 fl oz bottle", "shampoo"],
    ["trash bags 30 ct", "trash bags"],
    ["30 count trash bags", "trash bags"],
    ["can opener", "can opener"],
  ])("removes package syntax from %s without deleting product identity", (request, query) => {
    expect(stripDiscoveryPackageTerms(request)).toBe(query);
  });

  it("keeps strict attributes in intent while generating only three discovery levels", () => {
    const intent = parseProductIntent("Coke Zero 24 pack 12 oz cans");

    expect(intent).toMatchObject({
      brand: "Coca-Cola",
      brandRequired: true,
      category: "soda",
      requestedPackageLabel: "24-pack of 12 fl oz",
    });
    expect(intent.discoveryQueries).toEqual([
      { level: "normalized", query: "Coke Zero" },
      { level: "simplified", query: "Coca-Cola Zero sugar Soda" },
      { level: "broader", query: "Coca-Cola Soda" },
    ]);
  });

  it("normalizes bare volume shorthand but omits it from discovery", () => {
    const intent = parseProductIntent("2% milk gallon");

    expect(intent.requestedPackageLabel).toBe("1-gallon");
    expect(intent.requestedTotal).toBeUndefined();
    expect(intent.strictPackageRequest).toBe(true);
    expect(intent.discoveryQueries[0].query).toBe("2% milk");
    expect(intent.constraints.some((item) => item.label === "2% milk")).toBe(true);
    expect(extractMeasurement("whole milk gallon")?.baseAmount).toBe(128);
    expect(extractMeasurement("milk half gallon")?.baseAmount).toBe(64);
  });

  it("keeps package contents out of discovery without turning them into cart quantity", () => {
    const towels = parseProductIntent("paper towels 6 rolls");
    expect(towels).toMatchObject({
      requestedCartQuantity: 1,
      requestedPackageLabel: "6 count",
      strictPackageRequest: true,
    });
    expect(towels.discoveryQueries[0].query).toBe("paper towels");

    const eggs = parseProductIntent("2 dozen eggs");
    expect(eggs).toMatchObject({
      requestedCartQuantity: 2,
      requestedPackageLabel: "12 count",
      strictPackageRequest: true,
    });
    expect(eggs.discoveryQueries[0].query).toBe("eggs");
  });

  it.each([
    ["plain Greek yogurt 32 oz", "32 oz"],
    ["orange juice 52 fl oz", "52 fl oz"],
    ["white rice 5 lb", "5 lb"],
    ["chickpeas 15 oz", "15 oz"],
    ["coconut milk 13.5 fl oz", "13.5 fl oz"],
    ["frozen broccoli 10 oz", "10 oz"],
  ])("treats measured shelf packages as strict for %s", (request, packageLabel) => {
    const intent = parseProductIntent(request);
    expect(intent.strictPackageRequest).toBe(true);
    expect(intent.requestedPackageLabel).toBe(packageLabel);
    expect(intent.requestedTotal).toBeUndefined();
  });

  it.each([
    ["Chickpeas 3 cans", 3, "Chickpeas"],
    ["Diced Tomatoes 8 cans", 8, "Diced Tomatoes"],
    ["Kidney Beans 4 cans", 4, "Kidney Beans"],
    ["Light Coconut Milk 2 cans", 2, "Light Coconut Milk"],
  ])("separates a shopper's trailing can total from retailer package size: %s", (
    request,
    requestedCartQuantity,
    verificationText,
  ) => {
    expect(parseProductIntent(request)).toMatchObject({
      originalText: request,
      verificationText,
      fulfillmentText: verificationText,
      requestedCartQuantity,
      requestedContainer: "can",
      strictPackageRequest: false,
      requestedTotal: undefined,
    });
  });

  it.each([
    ["Ground Turkey 93/7 3 lb", "Ground Turkey 93 7", 48],
    ["Red Lentil Pasta 1.8 lb", "Red Lentil Pasta", 28.8],
    ["bananas 3 lb", "bananas", 48],
    ["pasta 2 lb total", "pasta", 32],
  ])("treats a requested physical amount as a fulfillable total: %s", (
    request,
    fulfillmentText,
    baseAmount,
  ) => {
    expect(parseProductIntent(request)).toMatchObject({
      originalText: request,
      verificationText: request,
      fulfillmentText,
      requestedCartQuantity: 1,
      strictPackageRequest: false,
      requestedPackageLabel: undefined,
      requestedTotal: {
        kind: "weight",
        baseAmount,
        baseUnit: "oz",
      },
    });
  });

  it("keeps explicit pack identity strict while allowing an explicit line multiplier", () => {
    expect(parseProductIntent("Coke Zero 24 pack")).toMatchObject({
      verificationText: "Coke Zero 24 pack",
      requestedCartQuantity: 1,
      requestedPackageLabel: "24-pack",
      requestedTotal: undefined,
      strictPackageRequest: true,
    });
    expect(parseProductIntent("Coke Zero 12 pack x2")).toMatchObject({
      verificationText: "Coke Zero 12 pack",
      requestedCartQuantity: 2,
      requestedPackageLabel: "12-pack",
      requestedTotal: undefined,
      strictPackageRequest: true,
    });
  });

  it.each([
    ["Tide detergent 92 fl oz", "Tide", "laundry detergent"],
    ["Dove body wash 20 fl oz", "Dove", "body wash"],
    ["Bounty paper towels 6 count", "Bounty", "paper towels"],
    ["Head and Shoulders shampoo 28 fl oz", "Head & Shoulders", "shampoo"],
  ])("preserves household and personal-care identity for %s", (request, brand, category) => {
    const intent = parseProductIntent(request);

    expect(intent.brand).toBe(brand);
    expect(intent.brandRequired).toBe(true);
    expect(intent.categoryLabel).toBe(category);
    expect(intent.discoveryQueries[0].query).toContain(brand.split(" ")[0]);
  });

  it("does not treat a matching household brand as a matching product category", () => {
    const intent = parseProductIntent("Dove body wash 20 fl oz");
    const shampoo = product("shampoo", "Dove Daily Moisture Shampoo, 20 fl oz", {
      brand: "Dove",
      productType: "shampoo",
    });
    const bodyWash = product("body-wash", "Dove Deep Moisture Body Wash, 20 fl oz", {
      brand: "Dove",
      productType: "body wash",
    });

    expect(isPlausibleDiscoveryCandidate(intent, shampoo)).toBe(false);
    expect(isPlausibleDiscoveryCandidate(intent, bodyWash)).toBe(true);
  });

  it("broadens progressively, pools candidates, deduplicates them, and stops on verification", async () => {
    const intent = parseProductIntent("Coke Zero 24 pack");
    const calls: string[] = [];
    const wrongBrand = product("pepsi", "Pepsi Zero Sugar Soda 24 Pack", {
      brand: "Pepsi",
      productType: "soda",
    });
    const wrongPack = product("coke-12", "Coca-Cola Zero Sugar Soda 12 Pack", {
      brand: "Coca-Cola",
      productType: "soda",
    });
    const exact = product("coke-24", "Coca-Cola Zero Sugar Soda 24 Pack", {
      brand: "Coca-Cola",
      productType: "soda",
    });

    const result = await retrieveCandidatesProgressively({
      intent,
      search: async (query) => {
        calls.push(query);
        if (calls.length === 1) return [wrongBrand, wrongPack];
        return [wrongPack, exact];
      },
      hasVerifiedMatch: (products) => products.some((item) => item.id === "coke-24"),
      isPlausible: (item) => isPlausibleDiscoveryCandidate(intent, item),
      candidateKey: (item) => item.id,
    });

    expect(calls).toEqual(["Coke Zero", "Coca-Cola Zero sugar Soda"]);
    expect(result.candidates.map((item) => item.id)).toEqual(["pepsi", "coke-12", "coke-24"]);
    expect(result.attempts.map((item) => item.outcome)).toEqual([
      "plausible_candidates",
      "verified",
    ]);
  });

  it("stops broadening when identity and package are sufficient but commerce evidence failed", async () => {
    const intent = parseProductIntent("Coke Zero 24 pack");
    const calls: string[] = [];
    const unavailable = product("unavailable", "Coca-Cola Zero Sugar Soda 24 Pack", {
      brand: "Coca-Cola",
      productType: "soda",
      inStock: false,
    });

    const result = await retrieveCandidatesProgressively({
      intent,
      search: async (query) => {
        calls.push(query);
        return [unavailable];
      },
      hasVerifiedMatch: () => false,
      hasSufficientCandidate: (products) => products.some((item) => item.id === "unavailable"),
      isPlausible: (item) => isPlausibleDiscoveryCandidate(intent, item),
    });

    expect(calls).toEqual(["Coke Zero"]);
    expect(result.attempts[0].outcome).toBe("sufficient_candidates");
  });

  it("treats an unmodified title as original but rejects a conflicting flavor", () => {
    const request = "Coca-Cola Original 12 pack";
    const constraints = analyzeProductFacets(request).constraints;
    const regular = product("regular", "Coca-Cola Soda Pop Cans, 12 fl oz, 12 Pack", {
      brand: "Coca-Cola",
      productType: "soda",
    });
    const cherry = product("cherry", "Coca-Cola Cherry Soda Pop Cans, 12 fl oz, 12 Pack", {
      brand: "Coca-Cola",
      productType: "soda",
    });

    const ranked = rankProducts(request, [cherry, regular], constraints);
    expect(ranked.recommended?.id).toBe("regular");
    expect(ranked.alternatives.map((item) => item.id)).not.toContain("cherry");
  });

  it.each([
    ["Bounty 6 Double Rolls", 6],
    ["Dove Beauty Bar 4 bars", 4],
    ["razor refill 12 blades", 12],
    ["Tide detergent 42 pacs", 42],
    ["cleaning wipes 80 wipes", 80],
  ])("normalizes household sell-unit counts in %s", (title, count) => {
    expect(extractMeasurement(title)).toMatchObject({
      kind: "count",
      baseAmount: count,
      baseUnit: "each",
    });
  });

  it("verifies every dimension of a counted capacity package", () => {
    const requested = extractMeasurement("13 gallon trash bags 40 count");
    const wrongCount = product("trash-20", "13 Gallon Trash Bags 20 Count", {
      productType: "trash bags",
    });
    const exact = product("trash-40", "13 Gallon Trash Bags 40 Count", {
      productType: "trash bags",
    });

    expect(requested).toMatchObject({
      kind: "volume",
      baseAmount: 13 * 128 * 40,
      packCount: 40,
      perPackageAmount: 13 * 128,
    });
    expect(wrongCount.size).toMatchObject({ packCount: 20, perPackageAmount: 13 * 128 });
    const result = rankProducts("13 gallon trash bags 40 count", [wrongCount, exact]);
    expect(result.recommended?.id).toBe("trash-40");
    expect(result.alternatives.map((item) => item.id)).not.toContain("trash-20");
  });

  it("fails closed on residual descriptors and explicit variants from the audit", () => {
    const cases: Array<{
      request: string;
      wrong: WalmartProduct;
      exact: WalmartProduct;
    }> = [
      {
        request: "1% milk 1 gallon",
        wrong: product("milk-whole", "Whole Milk 1 Gallon", { productType: "milk" }),
        exact: product("milk-one", "1% Lowfat Milk 1 Gallon", { productType: "milk" }),
      },
      {
        request: "organic large eggs 18 count",
        wrong: product("eggs-jumbo", "Organic Jumbo Eggs 18 Count", { productType: "eggs" }),
        exact: product("eggs-large", "Organic Grade A Large Eggs 18 Count", { productType: "eggs" }),
      },
      {
        request: "blueberry Greek yogurt 5.3 oz",
        wrong: product("yogurt-strawberry", "Strawberry Greek Yogurt 5.3 oz", { productType: "yogurt" }),
        exact: product("yogurt-blueberry", "Blueberry Greek Yogurt 5.3 oz", { productType: "yogurt" }),
      },
      {
        request: "organic ground beef 1 lb",
        wrong: product("ground-pork", "Organic Ground Pork 1 lb", { productType: "pork" }),
        exact: product("ground-beef", "Organic Ground Beef 1 lb", { productType: "ground beef" }),
      },
      {
        request: "Bimbo sourdough bread 20 oz",
        wrong: product("bimbo-white", "Bimbo Classic White Bread 20 oz", { productType: "bread", brand: "Bimbo" }),
        exact: product("bimbo-sourdough", "Bimbo Sourdough Bread 20 oz", { productType: "bread", brand: "Bimbo" }),
      },
      {
        request: "Cheerios Oat Crunch Berry cereal 18 oz",
        wrong: product("cheerios-original", "Original Cheerios Cereal 18 oz", { productType: "cereal", brand: "Cheerios" }),
        exact: product("cheerios-berry", "Cheerios Oat Crunch Berry Cereal 18 oz", { productType: "cereal", brand: "Cheerios" }),
      },
      {
        request: "Colgate Total Whitening toothpaste 4.8 oz",
        wrong: product("colgate-kids", "Colgate Kids Cavity Toothpaste 4.8 oz", { productType: "toothpaste", brand: "Colgate" }),
        exact: product("colgate-total", "Colgate Total Whitening Toothpaste 4.8 oz", { productType: "toothpaste", brand: "Colgate" }),
      },
      {
        request: "organic Hass avocados 4 count",
        wrong: product("avocado-green", "Fresh Organic Green Avocados 4 Count", { productType: "produce" }),
        exact: product("avocado-hass", "Fresh Organic Hass Avocados 4 Count", { productType: "produce" }),
      },
      {
        request: "Dove Cucumber body wash 20 fl oz",
        wrong: product("dove-moisture", "Dove Deep Moisture Body Wash 20 fl oz", { productType: "body wash", brand: "Dove" }),
        exact: product("dove-cucumber", "Dove Cucumber Body Wash 20 fl oz", { productType: "body wash", brand: "Dove" }),
      },
    ];

    for (const testCase of cases) {
      const constraints = analyzeProductFacets(testCase.request).constraints;
      const wrongOnly = rankProducts(testCase.request, [testCase.wrong], constraints);
      expect(wrongOnly.recommended, `${testCase.request} wrong-only`).toBeNull();

      const withExact = rankProducts(
        testCase.request,
        [testCase.wrong, testCase.exact],
        constraints,
      );
      expect(withExact.recommended?.id, testCase.request).toBe(testCase.exact.id);
    }
  });

  it("keeps dietary, percentage, ratio, and household form requirements strict", () => {
    const cases: Array<[string, string, string]> = [
      ["plain nonfat Greek yogurt 32 oz", "Plain Whole Milk Greek Yogurt 32 oz", "Plain Nonfat Greek Yogurt 32 oz"],
      ["gluten-free white bread 20 oz", "Classic White Sandwich Bread 20 oz", "Gluten-Free White Sandwich Bread 20 oz"],
      ["80/20 ground beef 1 lb", "90/10 Ground Beef 1 lb", "80/20 Ground Beef 1 lb"],
      ["Tide Free & Gentle liquid detergent 92 fl oz", "Tide Original Powder Detergent 92 oz", "Tide Free & Gentle Liquid Detergent 92 fl oz"],
      ["Dove Sensitive Skin body wash 20 fl oz", "Dove Deep Moisture Body Wash 20 fl oz", "Dove Sensitive Skin Body Wash 20 fl oz"],
    ];

    for (const [request, wrongTitle, exactTitle] of cases) {
      const brand = request.startsWith("Tide") ? "Tide" : request.startsWith("Dove") ? "Dove" : undefined;
      const productType = request.includes("yogurt")
        ? "yogurt"
        : request.includes("bread")
          ? "bread"
          : request.includes("beef")
            ? "ground beef"
            : request.includes("detergent")
              ? "laundry detergent"
              : "body wash";
      const wrong = product("wrong", wrongTitle, { brand, productType });
      const exact = product("exact", exactTitle, { brand, productType });
      const constraints = analyzeProductFacets(request).constraints;

      expect(rankProducts(request, [wrong], constraints).recommended, `${request} wrong-only`).toBeNull();
      expect(rankProducts(request, [wrong, exact], constraints).recommended?.id, request).toBe("exact");
    }
  });

  it.each([
    ["Tide detergent pods 42 count", "Tide Laundry Detergent Pacs 42 Count", "laundry detergent", "Tide"],
    ["unscented body wash 20 fl oz", "Fragrance-Free Shower Gel 20 fl oz", "shower gel", undefined],
    ["sugar-free yogurt 5.3 oz", "Zero Sugar Yogurt 5.3 oz", "yogurt", undefined],
    ["nonfat Greek yogurt 32 oz", "Fat-Free Greek Yogurt 32 oz", "yogurt", undefined],
    ["apple shampoo 20 fl oz", "Apple Moisture Shampoo 20 fl oz", "shampoo", undefined],
  ])("accepts equivalent category and descriptor aliases: %s", (request, title, productType, brand) => {
    const exact = product("alias", title, { productType, brand });
    const constraints = analyzeProductFacets(request).constraints;
    expect(rankProducts(request, [exact], constraints).recommended?.id).toBe("alias");
  });

  it("explains an exact-package failure from pooled retailer candidates", () => {
    const intent = parseProductIntent("Coke Zero 24 pack");
    const closest = product("coke-12", "Coca-Cola Zero Sugar Soda 12 Pack", {
      brand: "Coca-Cola",
      productType: "soda",
    });

    expect(explainDiscoveryFailure({
      retailerLabel: "Walmart",
      intent,
      candidates: [closest],
      exactPackage: (candidate) => candidate.size?.packCount === 24,
      commerceEligible: () => true,
    })).toBe("Coke Zero was found at Walmart, but no verified 24-pack package was available.");
  });

  it.each([
    ["coke", "Coca-Cola Gummies Candy", "Candy"],
    ["coke zero", "Coca-Cola Zero Sugar Gummies Candy", "Candy"],
  ])("rejects Coca-Cola licensed non-beverages for %s regardless of price", (request, title, productType) => {
    for (const price of [0.01, 999]) {
      const impostor = product("coke-candy", title, {
        brand: "Coca-Cola",
        productType,
        price,
      });
      expect(rankThroughServerIntent(request, [impostor])).toMatchObject({
        status: "no_match",
        recommended: null,
      });
    }
  });

  it("keeps an unprepared chicken-breast request away from breaded nuggets", () => {
    const prepared = product(
      "breaded-nuggets",
      "Tyson Breaded Chicken Breast Nuggets 2 lb",
      { brand: "Tyson", productType: "Frozen Chicken" },
    );
    expect(rankThroughServerIntent("chicken breast 2 lb", [prepared])).toMatchObject({
      status: "no_match",
      recommended: null,
    });
  });

  it("keeps a ground-beef request away from pre-formed cooked patties", () => {
    const prepared = product(
      "cooked-patties",
      "Kroger Fully Cooked Ground Beef Hamburger Patties 2 lb",
      { brand: "Kroger", productType: "Ground Beef" },
    );
    expect(rankThroughServerIntent("ground beef 2 lb", [prepared])).toMatchObject({
      status: "no_match",
      recommended: null,
    });
  });

  it.each([
    ["chicken breast", "PureBites Freeze Dried Chicken Breast Dog Treats"],
    ["ground beef", "PureBites Freeze Dried Ground Beef Dog Treats"],
  ])("never treats pet products as the requested human grocery: %s", (request, title) => {
    for (const price of [0.01, 999]) {
      const petProduct = product("pet-treat", title, {
        productType: "Dog Treats",
        price,
      });
      expect(rankProducts(request, [petProduct])).toMatchObject({
        status: "no_match",
        recommended: null,
      });
      expect(rankThroughServerIntent(request, [petProduct])).toMatchObject({
        status: "no_match",
        recommended: null,
      });
    }
  });

  it.each([
    ["laundry detergent", "Glass Laundry Detergent Dispenser", "Laundry Accessories"],
    ["toilet paper", "Chrome Toilet Paper Holder", "Bathroom Accessories"],
    ["water", "Replacement Water Filter Cartridge", "Water Filters"],
    ["milk", "Electric Milk Frother", "Kitchen Appliances"],
    ["bread", "Stainless Steel Bread Knife", "Kitchen Utensils"],
    ["coffee", "Programmable Coffee Maker", "Kitchen Appliances"],
    ["rice", "Electric Rice Cooker", "Kitchen Appliances"],
    ["water", "Stainless Steel Water Bottle", "Drinkware"],
    ["yogurt", "Automatic Yogurt Maker", "Kitchen Appliances"],
    ["cheese", "Stainless Steel Cheese Grater", "Kitchen Utensils"],
    ["pasta", "Manual Pasta Maker", "Kitchen Appliances"],
    ["toothpaste", "Wall Mount Toothpaste Dispenser", "Bathroom Accessories"],
    ["shampoo", "Refillable Shampoo Dispenser Bottle", "Bathroom Accessories"],
    ["dish soap", "Glass Dish Soap Dispenser", "Kitchen Accessories"],
    ["coffee", "Wood Coffee Pod Caddy", "Kitchen Accessories"],
  ])("never substitutes referenced hardware for a consumable: %s", (request, title, productType) => {
    for (const price of [0.01, 999]) {
      const accessory = product("accessory", title, { productType, price });
      expect(rankProducts(request, [accessory])).toMatchObject({
        status: "no_match",
        recommended: null,
      });
      expect(rankThroughServerIntent(request, [accessory])).toMatchObject({
        status: "no_match",
        recommended: null,
      });
    }
  });

  it("still accepts an explicitly requested accessory identity", () => {
    const holder = product("holder", "Chrome Toilet Paper Holder", {
      productType: "Bathroom Accessories",
    });
    expect(rankThroughServerIntent("toilet paper holder", [holder]).recommended?.id).toBe("holder");
  });

  it("still accepts an explicitly requested caddy identity", () => {
    const caddy = product("caddy", "Wood Coffee Pod Caddy", {
      productType: "Kitchen Accessories",
    });
    expect(rankThroughServerIntent("coffee pod caddy", [caddy]).recommended?.id).toBe("caddy");
  });
});
