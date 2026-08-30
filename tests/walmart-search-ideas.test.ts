import { describe, expect, it } from "vitest";
import { extractMeasurement } from "@/lib/measurements";
import { deriveWalmartSearchIdeas } from "@/lib/walmart-search-ideas";
import { eligibleWalmartSuggestionProducts } from "@/lib/walmart-suggestions";
import type { WalmartProduct } from "@/lib/types";

function product(
  id: string,
  title: string,
  options: Partial<WalmartProduct> = {},
): WalmartProduct {
  return {
    id,
    productId: `product-${id}`,
    itemId: `item-${id}`,
    title,
    brand: options.brand,
    productType: options.productType,
    price: options.price ?? 3.48,
    priceCents: Math.round((options.price ?? 3.48) * 100),
    link: `https://www.walmart.com/ip/${id}/item-${id}`,
    linkType: "product",
    dataSource: "serpapi",
    seller: "Walmart",
    inStock: true,
    sponsored: false,
    size: extractMeasurement(title),
    verification: "unverified",
    ...options,
  };
}

function ideas(
  query: string,
  products: WalmartProduct[],
  signals: Parameters<typeof deriveWalmartSearchIdeas>[2] = [],
) {
  const eligible = eligibleWalmartSuggestionProducts(query, products, []);
  return deriveWalmartSearchIdeas(query, eligible, signals).map((idea) => idea.text.toLowerCase());
}

function expectIdeaContaining(output: string[], pattern: RegExp) {
  expect(
    output.some((idea) => pattern.test(idea)),
    `Expected ${String(pattern)} in ${JSON.stringify(output)}`,
  ).toBe(true);
}

describe("Walmart result-derived search ideas", () => {
  it("excludes Decodo products whose response does not prove an eligible local price", () => {
    const unsafe = product("unsafe-decodo", "Coca-Cola Soda Pop, 12 Pack", {
      dataSource: "decodo",
      priceProvenance: {
        priceSource: "walmart_search",
        priceScope: "localized",
        requestedStoreId: "2201",
        fulfillment: ["pickup"],
        sellerType: "walmart",
        localPriceEligible: false,
        localPriceVerified: false,
      },
    });
    const safe = product("safe-decodo", "Coca-Cola Soda Pop Cans, 12 Pack", {
      dataSource: "decodo",
      priceProvenance: {
        priceSource: "local_store_search",
        priceScope: "exact_store",
        requestedStoreId: "2201",
        searchStoreId: "2201",
        searchStoreMatched: true,
        fulfillment: ["pickup"],
        sellerType: "walmart",
        localPriceEligible: true,
        localPriceVerified: true,
      },
    });

    const eligible = eligibleWalmartSuggestionProducts("coc", [unsafe, safe], []);

    expect(eligible.map((item) => item.id)).toEqual(["safe-decodo"]);
  });

  it("turns black forest ham results into type, style, and live-brand phrases", () => {
    const output = ideas("black forest ham", [
      product("gv-ham", "Great Value Black Forest Ham Lunch Meat, Thin Sliced, 9 oz", {
        brand: "Great Value",
        productType: "Lunch Meat",
      }),
      product("hillshire-ham", "Hillshire Farm Ultra Thin Sliced Black Forest Ham Lunch Meat, 16 oz", {
        brand: "Hillshire Farm",
        productType: "Lunch Meat",
      }),
      product("prima-ham", "Prima Della Black Forest Ham, Deli Sliced, 1 lb", {
        brand: "Prima Della",
        productType: "Deli Meat",
      }),
      product("turkey", "Hillshire Farm Black Forest Smoked Turkey Lunch Meat, 9 oz", {
        brand: "Hillshire Farm",
        productType: "Lunch Meat",
      }),
    ], [
      { text: "Lunch Meat", source: "filter", group: "Product Type", itemCount: 24 },
      { text: "Hillshire Farm", source: "filter", group: "Brand", itemCount: 8 },
      { text: "Black Forest Turkey", source: "related" },
    ]);

    expectIdeaContaining(output, /black forest ham .*lunch meat|lunch meat.*black forest ham/);
    expectIdeaContaining(output, /black forest ham .*deli/);
    expectIdeaContaining(output, /black forest ham .*sliced/);
    expectIdeaContaining(output, /black forest ham .*hillshire farm/);
    expect(output.some((idea) => /turkey/.test(idea))).toBe(false);
  });

  it("offers live chip brands and flavors while excluding baking chips", () => {
    const output = ideas("chips", [
      product("lays-original", "Lay's Classic Original Potato Chips, 8 oz Bag", {
        brand: "Lay's",
        productType: "Potato Chips",
      }),
      product("lays-sour", "Lay's Sour Cream & Onion Potato Chips, 7.75 oz Bag", {
        brand: "Lay's",
        productType: "Potato Chips",
      }),
      product("doritos-hot", "Doritos Flamin' Hot Nacho Flavored Tortilla Chips, 9.25 oz Bag", {
        brand: "Doritos",
        productType: "Tortilla Chips",
      }),
      product("ruffles", "Ruffles Cheddar & Sour Cream Potato Chips, 8.5 oz Bag", {
        brand: "Ruffles",
        productType: "Potato Chips",
      }),
      product("sunchips", "SunChips Original 100% Whole Grain Snacks, 7 oz Bag", {
        brand: "SunChips",
        productType: "Chips",
      }),
      product("chocolate", "Nestle Toll House Semi-Sweet Chocolate Chips, 12 oz Bag", {
        brand: "Nestle Toll House",
        productType: "Baking Chips",
      }),
    ]);

    expectIdeaContaining(output, /chips .*lay/);
    expectIdeaContaining(output, /chips .*doritos/);
    expectIdeaContaining(output, /chips .*sour cream/);
    expectIdeaContaining(output, /chips .*flamin.*hot/);
    expect(output.some((idea) => /chocolate|nestle|100%/.test(idea))).toBe(false);
  });

  it("keeps plain Coke on regular Coca-Cola ideas unless Zero was typed", () => {
    const products = [
      product("regular", "Coca-Cola Original Taste Soda Pop Cans, 12 fl oz, 12 Pack", {
        brand: "Coca-Cola",
        productType: "Soda",
      }),
      product("zero", "Coca-Cola Zero Sugar Soda Pop Cans, 12 fl oz, 12 Pack", {
        brand: "Coca-Cola",
        productType: "Soda",
      }),
    ];

    const plain = ideas("Coke", products, [
      { text: "Coke Zero", source: "related", score: 99 },
    ]);
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.some((idea) => /\bzero\b/.test(idea))).toBe(false);

    const zero = ideas("Coke Zero", products);
    expect(zero.length).toBeGreaterThan(0);
    expect(zero.every((idea) => /coke zero/i.test(idea))).toBe(true);
  });

  it("keeps cheese refinements in the cheese aisle rather than Doritos", () => {
    const output = ideas("cheese", [
      product("american", "Great Value American Cheese Singles, 16 oz, 24 Count", {
        brand: "Great Value",
        productType: "Cheese",
      }),
      product("swiss", "Sargento Ultra Thin Swiss Cheese Slices, 7 oz", {
        brand: "Sargento",
        productType: "Cheese",
      }),
      product("doritos", "Doritos Nacho Cheese Flavored Tortilla Chips, 9.25 oz", {
        brand: "Doritos",
        productType: "Tortilla Chips",
      }),
    ], [
      { text: "Doritos", source: "filter", group: "Brand", itemCount: 300 },
    ]);

    expectIdeaContaining(output, /cheese .*great value|cheese .*sargento/);
    expectIdeaContaining(output, /cheese .*swiss|swiss cheese/);
    expect(output.some((idea) => /doritos|tortilla chips/.test(idea))).toBe(false);
  });

  it("derives milk, shampoo, and battery attributes from each live result set", () => {
    const milk = ideas("milk", [
      product("whole", "Great Value Whole Vitamin D Milk, 1 Gallon", {
        brand: "Great Value",
        productType: "Milk",
      }),
      product("two-percent", "Hiland 2% Reduced Fat Milk, Half Gallon", {
        brand: "Hiland",
        productType: "Milk",
      }),
      product("candy", "Hershey's Milk Chocolate Candy Bar", {
        brand: "Hershey's",
        productType: "Candy",
      }),
    ]);
    expectIdeaContaining(milk, /milk .*whole|whole.*milk/);
    expectIdeaContaining(milk, /milk .*2%/);
    expect(milk.some((idea) => /candy|hershey/.test(idea))).toBe(false);

    const commaSeparatedMilk = ideas("milk", [
      product("whole-comma", "Great Value Milk Whole Vitamin D, Half Gallon, 64 fl oz", {
        brand: "Great Value",
        productType: "Milk",
      }),
      product("two-percent-comma", "Great Value Milk, 2% Reduced Fat, Half Gallon, 64 fl oz", {
        brand: "Great Value",
        productType: "Milk",
      }),
    ]);
    expectIdeaContaining(commaSeparatedMilk, /milk .*2%/);

    const liveShapedMilk = ideas("milk", [
      product("whole-half", "Great Value Milk Whole Vitamin D, Half Gallon, 64 fl oz", {
        brand: "Great Value", productType: "Milk",
      }),
      product("fat-free", "Great Value Milk, Fat Free, Unflavored, Half Gallon, 64 oz Jug", {
        brand: "Great Value", productType: "Milk",
      }),
      product("chocolate", "fairlife Lactose Free Reduced Fat Chocolate Ultra Filtered Milk, 52 fl oz", {
        brand: "fairlife", productType: "Milk",
      }),
      product("whole-gallon", "Great Value Whole Vitamin D Milk, Gallon", {
        brand: "Great Value", productType: "Milk",
      }),
      product("two-percent-half", "Great Value Milk, 2% Reduced Fat, Half Gallon, 64 fl oz", {
        brand: "Great Value", productType: "Milk",
      }),
      product("two-percent-filtered", "fairlife Lactose Free 2% Reduced Fat Ultra Filtered Milk, 52 fl oz", {
        brand: "fairlife", productType: "Milk",
      }),
    ]).slice(0, 5);
    expectIdeaContaining(liveShapedMilk, /milk .*2%/);

    const shampoo = ideas("shampoo", [
      product("dove", "Dove Daily Moisture Shampoo, 28 fl oz", {
        brand: "Dove",
        productType: "Shampoo",
      }),
      product("head-shoulders", "Head & Shoulders Classic Clean Dandruff Shampoo, 20.7 fl oz", {
        brand: "Head & Shoulders",
        productType: "Shampoo",
      }),
      product("body-wash", "Dove Deep Moisture Body Wash, 30.6 fl oz", {
        brand: "Dove",
        productType: "Body Wash",
      }),
    ]);
    expectIdeaContaining(shampoo, /shampoo .*dove/);
    expectIdeaContaining(shampoo, /shampoo .*daily moisture/);
    expectIdeaContaining(shampoo, /shampoo .*classic clean/);
    expect(shampoo.some((idea) => /body wash/.test(idea))).toBe(false);

    const batteries = ideas("batteries", [
      product("duracell", "Duracell Coppertop AA Alkaline Batteries, 8 Count", {
        brand: "Duracell",
        productType: "Batteries",
      }),
      product("energizer", "Energizer MAX AAA Alkaline Batteries, 4 Count", {
        brand: "Energizer",
        productType: "Batteries",
      }),
    ]);
    expectIdeaContaining(batteries, /batteries .*duracell/);
    expectIdeaContaining(batteries, /batteries .*aa/);
    expectIdeaContaining(batteries, /batteries .*aaa/);
    expectIdeaContaining(batteries, /batteries .*alkaline/);
  });

  it("uses fresh produce evidence and excludes processed products", () => {
    const output = ideas("tomatoes", [
      product("roma", "Fresh Roma Tomato, Each", { productType: "Fresh Produce" }),
      product("beefsteak", "Fresh Beefsteak Tomatoes, Each", { productType: "Fresh Produce" }),
      product("vine", "Fresh Tomatoes on the Vine, 1 lb", { productType: "Fresh Produce" }),
      product("canned", "Great Value Petite Diced Tomatoes, 14.5 oz Can", {
        brand: "Great Value",
        productType: "Canned Vegetables",
      }),
    ]);

    expectIdeaContaining(output, /tomatoes .*roma|roma tomato/);
    expectIdeaContaining(output, /tomatoes .*beefsteak|beefsteak tomatoes/);
    expect(output.some((idea) => /diced|canned|great value/.test(idea))).toBe(false);
  });

  it("supports unknown grocery phrases without borrowing related-looking products", () => {
    const output = ideas("dish sponges", [
      product("gv", "Great Value Non-Scratch Dish Sponges, 6 Count", {
        brand: "Great Value",
        productType: "Cleaning Tools",
      }),
      product("scotch", "Scotch-Brite Heavy Duty Dish Sponges, 3 Count", {
        brand: "Scotch-Brite",
        productType: "Cleaning Tools",
      }),
      product("soap", "Dawn Ultra Dish Soap, Original Scent, 18 fl oz", {
        brand: "Dawn",
        productType: "Dish Soap",
      }),
    ]);

    expectIdeaContaining(output, /dish sponges .*great value|dish sponges .*scotch/);
    expectIdeaContaining(output, /dish sponges .*non scratch|dish sponges .*heavy duty/);
    expect(output.some((idea) => /dawn|dish soap/.test(idea))).toBe(false);
    expect(ideas("zzzz", productsForUnknownFailure())).toEqual([]);
  });

  it("uses Walmart's spelling correction as a replacement instead of appending it to the typo", () => {
    const output = deriveWalmartSearchIdeas(
      "black forst ham",
      [product("ham", "Great Value Black Forest Ham Lunchmeat, 9 oz", {
        brand: "Great Value",
        productType: "Lunch Meat",
      })],
      [{ text: "black forest ham", source: "spelling" }],
    ).map((idea) => idea.text.toLowerCase());

    expect(output).toContain("black forest ham");
    expect(output.some((idea) => /black forst ham black forest ham/.test(idea))).toBe(false);
  });
});

function productsForUnknownFailure() {
  return [
    product("bread", "Great Value White Sandwich Bread, 20 oz", {
      brand: "Great Value",
      productType: "Bread",
    }),
  ];
}
