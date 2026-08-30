import { describe, expect, it } from "vitest";
import { extractMeasurement } from "@/lib/measurements";
import { rankProducts } from "@/lib/matching";
import type { WalmartProduct } from "@/lib/types";
import { verifySelectedProduct } from "@/lib/verification";

function candidate(
  id: string,
  title: string,
  price: number,
  options: Partial<WalmartProduct> = {},
): WalmartProduct {
  return {
    id,
    title,
    price,
    link: "https://www.walmart.com/ip/sample-product/123456789",
    linkType: "product",
    seller: "Walmart.com",
    inStock: true,
    sponsored: false,
    size: extractMeasurement(title),
    verification: "unverified",
    ...options,
  };
}

function currentDetail(product: WalmartProduct, options: Partial<WalmartProduct> = {}) {
  return {
    ...product,
    checkedAt: new Date().toISOString(),
    ...options,
  };
}

describe("brand-safe product matching", () => {
  it("recognizes 7UP and rejects a Great Value substitute", () => {
    const result = rankProducts("7 up 12 pack soda", [
      candidate("store-brand", "Great Value Lemon Lime Soda, 12 Pack, 12 fl oz Cans", 4.98, {
        brand: "Great Value",
        productType: "soda",
      }),
      candidate("7up", "7UP Lemon Lime Soda, 12 Pack, 12 fl oz Cans", 7.97, {
        brand: "7UP",
        productType: "soda",
      }),
    ]);

    expect(result.recommended?.id).toBe("7up");
    expect(result.alternatives.map((item) => item.id)).not.toContain("store-brand");
  });

  it("recognizes 7 Up as a named brand even when soda is omitted", () => {
    const result = rankProducts("7 Up 12 pack", [
      candidate("7up", "7UP Caffeine Free Lemon Lime Soda Pop, 12 fl oz, 12 Pack Cans", 6.78, {
        productType: "soda",
      }),
    ]);

    expect(result.recommended?.id).toBe("7up");
  });

  it("never returns Great Value for an exact Takis request", () => {
    const result = rankProducts("takis", [
      candidate("store-brand", "Great Value Takis Style Rolled Chips, 9 oz", 2.48, {
        brand: "Great Value",
        productType: "snack chips",
      }),
    ]);

    expect(result.recommended).toBeNull();
    expect(result.status).not.toBe("matched");
  });

  it("reports no verified named-brand match when only a store brand is available", () => {
    const result = rankProducts("takis fuego 9.9 oz", [
      candidate("store-brand", "Great Value Hot Chili Lime Rolled Chips, 9.9 oz", 2.48, {
        brand: "Great Value",
        productType: "snack chips",
      }),
    ]);

    expect(result.status).toBe("no_match");
    expect(result.recommended).toBeNull();
    expect(result.explanation).toBe("No verified Takis match found.");
  });

  it("rejects Great Value for a coke zero brand request", () => {
    const result = rankProducts("coke zero", [
      candidate("store-brand", "Great Value Coke Zero Sugar Cola, 12 Pack, 12 fl oz Cans", 4.98, {
        brand: "Great Value",
        productType: "soda",
      }),
      candidate("coke", "Coca-Cola Zero Sugar Soda, 12 Pack, 12 fl oz Cans", 8.98, {
        brand: "Coca-Cola",
        productType: "soda",
      }),
    ]);

    expect(result.recommended?.id).toBe("coke");
    expect(result.alternatives.map((item) => item.id)).not.toContain("store-brand");
  });

  it("returns no reliable match when only a store-brand substitution exists", () => {
    const result = rankProducts("Pepsi", [
      candidate("store-brand", "Great Value Cola Soda, 2 Liter", 1.24, {
        brand: "Great Value",
        productType: "soda",
      }),
    ]);
    expect(result.status).toBe("no_match");
    expect(result.recommended).toBeNull();
  });
});

describe("common-sense defaults", () => {
  it("never substitutes whole milk for an explicit 2% gallon request", () => {
    const result = rankProducts("2% milk gallon", [
      candidate("whole", "Whole Milk, 1 Gallon", 2.99, {
        productType: "milk",
      }),
      candidate("two-percent", "2% Reduced Fat Milk, 1 Gallon", 3.99, {
        productType: "milk",
      }),
    ]);

    expect(result.recommended?.id).toBe("two-percent");
    expect(result.alternatives.map((item) => item.id)).not.toContain("whole");
  });

  it("selects a standard Takis bag without requiring a flavor or size", () => {
    const result = rankProducts("takis", [
      candidate("snack", "Takis Fuego Rolled Tortilla Chips, 1 oz Bag", 0.79, {
        brand: "Takis",
        productType: "snack chips",
      }),
      candidate("standard", "Takis Fuego Rolled Tortilla Chips, 9.9 oz Bag", 3.48, {
        brand: "Takis",
        productType: "snack chips",
      }),
      candidate("family", "Takis Fuego Rolled Tortilla Chips, 17 oz Bag", 5.98, {
        brand: "Takis",
        productType: "snack chips",
      }),
    ]);

    expect(result.recommended?.id).toBe("standard");
    expect(result.assumptions).toContain("Assumed standard bag");
    expect(result.assumptions).toContain("Assumed Fuego flavor");
    expect(result.clarification).toBeUndefined();
  });

  it("honors an exact live Walmart typeahead choice after normal safety checks", () => {
    const smaller = candidate("small", "Takis Fuego Rolled Tortilla Chips, 9.9 oz Bag", 3.48, {
      brand: "Takis",
      productId: "SMALL-TAKIS",
      productType: "snack chips",
    });
    const selected = candidate("selected", "Takis Fuego Rolled Tortilla Chips, 17 oz Bag", 5.98, {
      brand: "Takis",
      productId: "SELECTED-TAKIS",
      productType: "snack chips",
    });

    const result = rankProducts("Takis Fuego", [smaller, selected], [], {
      productId: "SELECTED-TAKIS",
      title: selected.title,
    });

    expect(result.recommended?.productId).toBe("SELECTED-TAKIS");
    expect(result.recommended?.reasons).toContain("selected from live Walmart suggestions");
  });

  it("keeps plain Takis Fuego on rolled tortilla chips instead of cheaper line extensions", () => {
    const result = rankProducts("Takis Fuego", [
      candidate("pix", "Takis Fuego Pix 8.5 oz Sharing Size Crunchy Corn Puff Bag", 3.47, {
        brand: "Takis",
        productType: "snack chips",
      }),
      candidate("stix", "Takis Fuego Stix 9.9 oz Bag, Hot Chili Pepper & Lime Corn Snack Sticks", 3.48, {
        brand: "Takis",
        productType: "snack chips",
      }),
      candidate("kettlez", "Takis Fuego Kettlez 8 oz Kettle-Cooked Potato Chips", 3.28, {
        brand: "Takis",
        productType: "snack chips",
      }),
      candidate("waves", "Takis Fuego Waves 8 oz Wavy Potato Chips", 3.18, {
        brand: "Takis",
        productType: "snack chips",
      }),
      candidate("crisps", "Takis Fuego Crisps 5.5 oz Potato Crisps", 2.68, {
        brand: "Takis",
        productType: "snack chips",
      }),
      candidate("rolled", "Takis Fuego 9.9 oz Bag, Hot Chili Pepper & Lime Rolled Tortilla Chips", 4.08, {
        brand: "Takis",
        productType: "snack chips",
      }),
    ]);

    expect(result.recommended?.id).toBe("rolled");
    expect(result.alternatives.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(["pix", "stix", "kettlez", "waves", "crisps"]),
    );
  });

  it("does not claim a default Takis match when only specialty product families are available", () => {
    const result = rankProducts("Takis", [
      candidate("pix", "Takis Fuego Pix 8.5 oz Crunchy Corn Puff Bag", 3.47, {
        brand: "Takis",
        productType: "snack chips",
      }),
      candidate("stix", "Takis Fuego Stix 9.9 oz Corn Snack Sticks", 4.08, {
        brand: "Takis",
        productType: "snack chips",
      }),
    ]);

    expect(result).toMatchObject({ status: "no_match", recommended: null });
  });

  it.each([
    ["Takis Stix", "Takis Fuego Stix 9.9 oz Corn Snack Sticks"],
    ["Takis Pix", "Takis Fuego Pix 8.5 oz Crunchy Corn Puff Bag"],
    ["Takis Kettlez", "Takis Fuego Kettlez 8 oz Kettle-Cooked Potato Chips"],
    ["Takis Waves", "Takis Fuego Waves 8 oz Wavy Potato Chips"],
    ["Takis Crisps", "Takis Fuego Crisps 5.5 oz Potato Crisps"],
  ])("allows an explicitly requested Takis specialty family: %s", (request, title) => {
    const specialty = candidate("specialty", title, 3.48, {
      brand: "Takis",
      productType: "snack chips",
    });
    const result = rankProducts(request, [
      candidate("rolled", "Takis Fuego Rolled Tortilla Chips, 9.9 oz Bag", 4.08, {
        brand: "Takis",
        productType: "snack chips",
      }),
      specialty,
    ]);

    expect(result.recommended?.id).toBe("specialty");
  });

  it("selects a reasonable Bimbo snack without demanding a package size", () => {
    const result = rankProducts("bimbo snack", [
      candidate("mantecadas", "Bimbo Mantecadas Vanilla Mini Muffins, 8 Count", 3.98, {
        brand: "Bimbo",
        productType: "snack cakes",
      }),
    ]);

    expect(result.recommended?.id).toBe("mantecadas");
    expect(result.assumptions).toContain("Assumed a common package size");
  });

  it("prefers a common Coke Zero multipack while preserving Coca-Cola", () => {
    const result = rankProducts("coke zero", [
      candidate("single", "Coca-Cola Zero Sugar Soda, 20 fl oz Bottle", 2.28, {
        brand: "Coca-Cola",
        productType: "soda",
      }),
      candidate("multipack", "Coca-Cola Zero Sugar Soda, 12 Pack, 12 fl oz Cans", 8.98, {
        brand: "Coca-Cola",
        productType: "soda",
      }),
    ]);

    expect(result.recommended?.id).toBe("multipack");
    expect(result.recommended?.brand).toBe("Coca-Cola");
    expect(result.assumptions).toContain("Assumed common 12-pack");
  });

  it("selects a common Gatorade lemon lime package without requiring a size", () => {
    const result = rankProducts("gatorade lemon lime", [
      candidate("single", "Gatorade Lemon Lime Thirst Quencher, 20 fl oz Bottle", 1.88, {
        brand: "Gatorade",
        productType: "sports drink",
      }),
      candidate("multipack", "Gatorade Lemon Lime Thirst Quencher, 12 Pack, 12 fl oz Bottles", 8.78, {
        brand: "Gatorade",
        productType: "sports drink",
      }),
    ]);

    expect(result.recommended?.id).toBe("multipack");
    expect(result.assumptions).toContain("Assumed common 12-pack");
  });

  it("requires clarification for cranberry", () => {
    const result = rankProducts("cranberry", [
      candidate("juice", "Cranberry Juice Cocktail, 64 fl oz", 2.84),
    ]);
    expect(result.status).toBe("review");
    expect(result.recommended).toBeNull();
    expect(result.clarification).toContain("fresh cranberries");
  });

  it("chooses a reasonable bread instead of requiring type and loaf size", () => {
    const result = rankProducts("bread", [
      candidate("white", "White Sandwich Bread, 20 oz Loaf", 1.42),
    ]);
    expect(result.status).toBe("review");
    expect(result.recommended?.id).toBe("white");
    expect(result.clarification).toBeUndefined();
  });
});

describe("generalized product identity precision", () => {
  const collisions = [
    {
      request: "cheese",
      validTitle: "Great Value American Cheese Singles, 16 oz",
      validType: "cheese",
      impostorTitle: "Doritos Nacho Cheese Flavored Tortilla Chips, 9.25 oz",
      impostorType: "snack chips",
    },
    {
      request: "yogurt",
      validTitle: "Great Value Plain Whole Milk Yogurt, 32 oz",
      validType: "yogurt",
      impostorTitle: "Yogurt Covered Pretzels, 7 oz",
      impostorType: "snack pretzels",
    },
    {
      request: "milk",
      validTitle: "Great Value Whole Vitamin D Milk, 1 gal",
      validType: "milk",
      impostorTitle: "Hershey's Milk Chocolate Candy Bar, 1.55 oz",
      impostorType: "candy",
    },
    {
      request: "bread",
      validTitle: "Great Value White Sandwich Bread, 20 oz",
      validType: "bread",
      impostorTitle: "Progresso Italian Style Bread Crumbs, 15 oz",
      impostorType: "bread crumbs",
    },
    {
      request: "tuna",
      validTitle: "StarKist Chunk Light Tuna in Water, 5 oz Can",
      validType: "canned tuna",
      impostorTitle: "Fancy Feast Tuna Recipe Cat Food, 3 oz Can",
      impostorType: "cat food",
    },
    {
      request: "chips",
      validTitle: "Lay's Classic Potato Chips, 8 oz",
      validType: "snack chips",
      impostorTitle: "Nestle Toll House Semi-Sweet Chocolate Chips, 12 oz",
      impostorType: "baking chips",
    },
    {
      request: "water",
      validTitle: "Great Value Purified Drinking Water, 1 Gallon",
      validType: "drinking water",
      impostorTitle: "Mio Water Enhancer, 1.62 fl oz",
      impostorType: "drink mix",
    },
    {
      request: "cereal",
      validTitle: "Great Value Toasted Oats Cereal, 18 oz",
      validType: "breakfast cereal",
      impostorTitle: "Kellogg's Cereal Bars, 8 Count",
      impostorType: "snack bars",
    },
    {
      request: "coffee",
      validTitle: "Folgers Classic Roast Ground Coffee, 12 oz",
      validType: "ground coffee",
      impostorTitle: "Coffee mate French Vanilla Coffee Creamer, 32 fl oz",
      impostorType: "coffee creamer",
    },
    {
      request: "banana",
      validTitle: "Fresh Banana, Each",
      validType: "fresh produce",
      impostorTitle: "Gerber Banana Baby Food, 4 oz",
      impostorType: "baby food",
    },
    {
      request: "steak",
      validTitle: "Fresh Beef Ribeye Steak, 1 lb",
      validType: "fresh meat",
      impostorTitle: "McCormick Montreal Steak Seasoning, 3.4 oz",
      impostorType: "seasoning",
    },
  ];

  it.each(collisions)("hard-rejects $request word collisions", ({
    request,
    validTitle,
    validType,
    impostorTitle,
    impostorType,
  }) => {
    const impostor = candidate("impostor", impostorTitle, 0.25, { productType: impostorType });
    const valid = candidate("valid", validTitle, 7.25, { productType: validType });

    const mixed = rankProducts(request, [impostor, valid]);
    expect(mixed.recommended?.id).toBe("valid");
    expect(mixed.alternatives.map((item) => item.id)).not.toContain("impostor");

    const onlyImpostor = rankProducts(request, [impostor]);
    expect(onlyImpostor).toMatchObject({ status: "no_match", recommended: null });
  });

  const cokeProducts = [
    candidate("regular", "Coca-Cola Original Taste Soda Pop, 12 Pack Cans", 9, {
      brand: "Coca-Cola",
      productType: "soda",
    }),
    candidate("zero", "Coca-Cola Zero Sugar Soda Pop, 12 Pack Cans", 1, {
      brand: "Coca-Cola",
      productType: "soda",
    }),
    candidate("diet", "Diet Coke Soda Pop, 12 Pack Cans", 1, {
      brand: "Coca-Cola",
      productType: "soda",
    }),
    candidate("cherry", "Coca-Cola Cherry Soda Pop, 12 Pack Cans", 1, {
      brand: "Coca-Cola",
      productType: "soda",
    }),
  ];

  it("treats an unqualified Coke request as regular Coca-Cola", () => {
    const result = rankProducts("coke", cokeProducts);
    expect(result.recommended?.id).toBe("regular");
    expect(result.recommended?.confidence).not.toBe("low");
    expect(result.alternatives.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(["zero", "diet", "cherry"]),
    );
    expect(rankProducts("coke", cokeProducts.slice(1))).toMatchObject({
      status: "no_match",
      recommended: null,
    });
  });

  it.each([
    ["coke zero", "zero"],
    ["diet coke", "diet"],
    ["cherry coke", "cherry"],
  ])("preserves an explicitly requested soda variety for %s", (request, expectedId) => {
    const result = rankProducts(request, cokeProducts);
    expect(result.recommended?.id).toBe(expectedId);
    expect(result.recommended?.confidence).not.toBe("low");
    expect(result.alternatives.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(cokeProducts.map((item) => item.id).filter((id) => id !== expectedId)),
    );
  });

  it.each([
    ["chocolate milk", "Great Value Chocolate Milk, 1 Quart", "milk"],
    ["bread crumbs", "Progresso Italian Style Bread Crumbs, 15 oz", "bread crumbs"],
    ["chocolate chips", "Nestle Toll House Semi-Sweet Chocolate Chips, 12 oz", "baking chips"],
    ["cereal bars", "Kellogg's Strawberry Cereal Bars, 8 Count", "snack bars"],
    ["coffee creamer", "Coffee mate French Vanilla Coffee Creamer, 32 fl oz", "coffee creamer"],
    ["tuna cat food", "Fancy Feast Tuna Recipe Cat Food, 3 oz Can", "cat food"],
    ["steak seasoning", "McCormick Montreal Steak Seasoning, 3.4 oz", "seasoning"],
    ["mac and cheese", "Kraft Original Macaroni and Cheese Dinner, 7.25 oz", "prepared meal"],
  ])("keeps an explicitly qualified request valid: %s", (request, title, productType) => {
    expect(rankProducts(request, [candidate("qualified", title, 4.98, { productType })]).recommended?.id)
      .toBe("qualified");
  });
});

describe("fresh produce defaults", () => {
  it("turns a broad vegetables request into a concrete fresh option", () => {
    const result = rankProducts("vegetables", [
      candidate("frozen", "Great Value Mixed Vegetables, 12 oz Steamable Bag (Frozen)", 0.98, {
        productType: "Frozen Vegetables",
      }),
      candidate("canned", "Great Value Mixed Vegetables, 15 oz Can", 0.88, {
        productType: "Canned & Jarred Vegetables",
      }),
      candidate("fresh", "Fresh Broccoli Crowns, Each", 2.48, {
        productType: "Fresh Produce",
      }),
    ]);

    expect(result.recommended?.id).toBe("fresh");
    expect(result.alternatives.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(["frozen", "canned"]),
    );
  });

  it("selects fresh asparagus instead of cheaper canned or frozen asparagus", () => {
    const result = rankProducts("asparagus", [
      candidate("canned", "Great Value Asparagus Cut Spears, 14.5 oz Can", 1.28, {
        productType: "Canned & Jarred Vegetables",
      }),
      candidate("frozen", "Frozen Asparagus Spears, 10 oz Bag", 1.98, {
        productType: "Frozen Vegetables",
      }),
      candidate("fresh", "Fresh Asparagus, 1 lb Bunch", 3.98, {
        productType: "Fresh Produce",
      }),
    ]);

    expect(result.recommended?.id).toBe("fresh");
    expect(result.alternatives.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(["canned", "frozen"]),
    );
  });

  it("selects fresh broccoli instead of cheaper frozen broccoli", () => {
    const result = rankProducts("broccoli", [
      candidate("frozen", "Great Value Frozen Broccoli Florets, 12 oz", 1.16, {
        productType: "Frozen Vegetables",
      }),
      candidate("fresh", "Fresh Broccoli Crowns, Each", 2.28, {
        productType: "Fresh Produce",
      }),
    ]);

    expect(result.recommended?.id).toBe("fresh");
    expect(result.alternatives.map((item) => item.id)).not.toContain("frozen");
  });

  it("matches singular and plural forms of the same produce identity only", () => {
    const result = rankProducts("tomatoes", [
      candidate("unrelated", "Fresh Broccoli Crowns, Each", 0.98, {
        productType: "Fresh Produce",
      }),
      candidate("tomato", "Fresh Roma Tomato, Each", 1.48, {
        productType: "Fresh Vegetables",
      }),
    ]);

    expect(result.recommended?.id).toBe("tomato");
    expect(result.alternatives.map((item) => item.id)).not.toContain("unrelated");
  });

  it.each([
    ["canned asparagus", "Canned Asparagus Spears, 14.5 oz Can", "Canned & Jarred Vegetables"],
    ["frozen broccoli", "Frozen Broccoli Florets, 12 oz Bag", "Frozen Vegetables"],
    ["pickled asparagus", "Pickled Asparagus Spears, 16 oz Jar", "Pickled Vegetables"],
    ["dried vegetables", "Dried Mixed Vegetables, 8 oz Bag", "Dried Vegetables"],
  ])("keeps an explicitly requested produce form valid: %s", (request, title, productType) => {
    const result = rankProducts(request, [
      candidate("requested-form", title, 3.48, { productType }),
      candidate("fresh", "Fresh Asparagus, 1 lb Bunch", 1.48, {
        productType: "Fresh Produce",
      }),
    ]);

    expect(result.recommended?.id).toBe("requested-form");
    expect(result.alternatives.map((item) => item.id)).not.toContain("fresh");
  });

  it.each([
    ["bell peppers", "Fresh Bell Peppers, 3 Count"],
    ["cucumber", "Fresh Cucumber, Each"],
    ["zucchini", "Fresh Zucchini Squash, Each"],
    ["squash", "Fresh Yellow Squash, Each"],
    ["cauliflower", "Fresh Cauliflower Head, Each"],
    ["celery", "Fresh Celery Stalk, Each"],
    ["cilantro", "Fresh Whole Green Cilantro Bunch, Fresh Produce"],
    ["parsley", "Fresh Parsley Bunch, Fresh Produce"],
    ["basil", "Fresh Basil, 1 Each, Fresh Produce"],
  ])("recognizes %s as fresh produce", (request, title) => {
    expect(rankProducts(request, [candidate("fresh", title, 1.98, {
      productType: "Fresh Produce",
    })]).recommended?.id).toBe("fresh");
  });

  it("keeps dried herbs out of an unqualified fresh-herb request", () => {
    const result = rankProducts("cilantro", [
      candidate("dried", "Dried Cilantro Leaves, 0.4 oz Bottle", 0.98, {
        productType: "Herbs & Spices",
      }),
      candidate("fresh", "Fresh Whole Green Cilantro Bunch, Fresh Produce", 1.48, {
        productType: "Fresh Produce",
      }),
    ]);

    expect(result.recommended?.id).toBe("fresh");
    expect(result.alternatives.map((item) => item.id)).not.toContain("dried");
  });

  it("accepts dried cilantro only when the shopper asks for it", () => {
    const result = rankProducts("dried cilantro", [
      candidate("dried", "Dried Cilantro Leaves, 0.4 oz Bottle", 0.98, {
        productType: "Herbs & Spices",
      }),
      candidate("fresh", "Fresh Whole Green Cilantro Bunch, Fresh Produce", 1.48, {
        productType: "Fresh Produce",
      }),
    ]);

    expect(result.recommended?.id).toBe("dried");
    expect(result.alternatives.map((item) => item.id)).not.toContain("fresh");
  });
});

describe("verified matches", () => {
  it("rechecks the fresh produce form against product details", () => {
    const searchProduct = candidate("asparagus", "Fresh Asparagus, 1 lb Bunch", 3.98, {
      productType: "Fresh Produce",
    });
    const result = verifySelectedProduct(
      "asparagus",
      rankProducts("asparagus", [searchProduct]),
      currentDetail(searchProduct, {
        title: "Great Value Asparagus Cut Spears, 14.5 oz Can",
        productType: "Canned & Jarred Vegetables",
      }),
    );

    expect(result.status).toBe("review");
    expect(result.recommended?.verificationIssues).toContain(
      "requested fresh produce, but the product is canned",
    );
  });

  it("verifies canned asparagus when canned was explicitly requested", () => {
    const canned = candidate("canned-asparagus", "Canned Asparagus Spears, 14.5 oz Can", 2.48, {
      productType: "Canned & Jarred Vegetables",
    });
    const result = verifySelectedProduct(
      "canned asparagus",
      rankProducts("canned asparagus", [canned]),
      currentDetail(canned),
    );

    expect(result.status).toBe("matched");
    expect(result.recommended?.verificationIssues).toEqual([]);
  });

  it("accepts a verified 32-ounce plain Greek yogurt tub", () => {
    const searchProduct = candidate(
      "tub",
      "Great Value Plain Nonfat Greek Yogurt, 32 oz Tub",
      3.54,
      { brand: "Great Value", productType: "Greek yogurt" },
    );
    const preliminary = rankProducts("plain Greek yogurt 32 oz", [
      searchProduct,
      candidate("cups", "Oikos Vanilla Greek Yogurt, 4 Pack, 5.3 oz Cups", 3.28, {
        brand: "Oikos",
        productType: "Greek yogurt",
      }),
    ]);
    const verified = verifySelectedProduct(
      "plain Greek yogurt 32 oz",
      preliminary,
      currentDetail(searchProduct),
    );

    expect(verified.status).toBe("matched");
    expect(verified.recommended?.size?.baseAmount).toBe(32);
    expect(verified.explanation).toContain("local Walmart store price");
  });

  it("does not hide a suspicious Gatorade search price behind a higher detail price", () => {
    const suspiciousSearchPrice = candidate(
      "gatorade-pack",
      "Gatorade Lemon Lime Thirst Quencher, 12 Pack, 12 fl oz Bottles",
      1.87,
      { brand: "Gatorade", productType: "sports drink" },
    );
    const preliminary = rankProducts("Gatorade lemon lime 12 pack 12 oz", [
      suspiciousSearchPrice,
      candidate("single", "Gatorade Lemon Lime Thirst Quencher, 12 fl oz Bottle", 1.87, {
        brand: "Gatorade",
        productType: "sports drink",
      }),
    ]);
    const verified = verifySelectedProduct(
      "Gatorade lemon lime 12 pack 12 oz",
      preliminary,
      currentDetail(suspiciousSearchPrice, {
        price: 8.78,
        reportedUnitPrice: 8.78 / 12,
        reportedUnitBasis: "each",
      }),
    );

    expect(preliminary.recommended?.id).toBe("gatorade-pack");
    expect(preliminary.alternatives.map((item) => item.id)).not.toContain("single");
    expect(verified.status).toBe("review");
    expect(verified.recommended?.price).toBe(1.87);
    expect(verified.recommended?.verificationIssues).toContain(
      "reported unit price is inconsistent with the total price",
    );
  });

  it("chooses the lowest valid local Coke Zero 24-pack and rejects marketplace offers", () => {
    const local = candidate(
      "local-coke",
      "Coca-Cola Zero Sugar Soda Pop Cans, 12 fl oz, 24 Pack",
      14.97,
      {
        productId: "LOCAL-COKE",
        brand: "Coca-Cola",
        productType: "soda",
        dataSource: "serpapi",
        priceCents: 1497,
        priceProvenance: {
          priceSource: "local_store_search",
          searchPriceCents: 1497,
          requestedStoreId: "2201",
          searchStoreId: "2201",
          searchStoreMatched: true,
          fulfillment: [],
          sellerType: "walmart",
          localPriceEligible: true,
          localPriceVerified: false,
        },
      },
    );
    const marketplace = candidate(
      "marketplace-coke",
      "Coca-Cola Zero Sugar, 16.9 Ounce (24 Pack)",
      33.33,
      {
        productId: "MARKETPLACE-COKE",
        brand: "Coca-Cola",
        productType: "soda",
        seller: "Nova Wholesale",
        dataSource: "serpapi",
        priceCents: 3333,
        priceProvenance: {
          priceSource: "marketplace_search",
          searchPriceCents: 3333,
          requestedStoreId: "2201",
          searchStoreId: "2201",
          searchStoreMatched: true,
          fulfillment: ["shipping"],
          sellerType: "marketplace",
          localPriceEligible: false,
          localPriceVerified: false,
        },
      },
    );

    const result = rankProducts("Coke Zero 24 pack", [marketplace, local]);
    expect(result.recommended?.id).toBe("local-coke");
    expect(result.alternatives.map((item) => item.id)).not.toContain("marketplace-coke");
  });

  it("rejects a live Decodo result when the response does not prove an eligible local price", () => {
    const unverifiedStorePrice = candidate(
      "decodo-unverified-store",
      "Coca-Cola Zero Sugar Soda Pop Cans, 12 fl oz, 24 Pack",
      14.97,
      {
        productId: "DECODO-COKE",
        brand: "Coca-Cola",
        productType: "soda",
        dataSource: "decodo",
        priceCents: 1497,
        priceProvenance: {
          priceSource: "walmart_search",
          priceScope: "localized",
          searchPriceCents: 1497,
          requestedStoreId: "2201",
          fulfillment: ["pickup"],
          sellerType: "walmart",
          localPriceEligible: false,
          localPriceVerified: false,
        },
      },
    );

    const result = rankProducts("Coke Zero 24 pack", [unverifiedStorePrice]);

    expect(result.status).toBe("no_match");
    expect(result.recommended).toBeNull();
  });

  it("never substitutes a closest pack when the requested Coke Zero pack is unavailable", () => {
    const closest = candidate(
      "coke-12",
      "Coca-Cola Zero Sugar Soda Pop Cans, 12 fl oz, 12 Pack",
      8.42,
      { brand: "Coca-Cola", productType: "soda" },
    );
    const preliminary = rankProducts("Coke Zero 24 pack", [closest]);

    expect(preliminary.status).toBe("no_match");
    expect(preliminary.recommended).toBeNull();
    expect(preliminary.alternatives).toEqual([]);
  });

  it("requires Gatorade, lemon lime, and the exact 12-pack size", () => {
    const result = rankProducts("gatorade lemon lime 12 pack 12 oz", [
      candidate("wrong-flavor", "Gatorade Orange Thirst Quencher, 12 Pack, 12 fl oz Bottles", 8.78, {
        brand: "Gatorade",
        productType: "sports drink",
      }),
      candidate("wrong-pack", "Gatorade Lemon Lime Thirst Quencher, 8 Pack, 12 fl oz Bottles", 6.98, {
        brand: "Gatorade",
        productType: "sports drink",
      }),
      candidate("correct", "Gatorade Lemon Lime Thirst Quencher, 12 Pack, 12 fl oz Bottles", 8.78, {
        brand: "Gatorade",
        productType: "sports drink",
      }),
    ]);

    expect(result.recommended?.id).toBe("correct");
    expect(result.alternatives.map((item) => item.id)).not.toContain("wrong-flavor");
    expect(result.alternatives.map((item) => item.id)).not.toContain("wrong-pack");
  });

  it("allows a verified Great Value cranberry juice when no brand was requested", () => {
    const searchProduct = candidate(
      "cranberry-juice",
      "Great Value Cranberry Juice Cocktail, 64 fl oz",
      2.84,
      { brand: "Great Value", productType: "cranberry juice" },
    );
    const result = verifySelectedProduct(
      "cranberry juice",
      rankProducts("cranberry juice", [searchProduct]),
      currentDetail(searchProduct),
    );

    expect(result.status).toBe("matched");
    expect(result.recommended?.brand).toBe("Great Value");
  });

  it("rejects obviously unrelated egg products", () => {
    const result = rankProducts("eggs", [
      candidate("candy", "Cadbury Creme Chocolate Eggs, 5 Count", 4.88),
    ]);
    expect(result.status).toBe("no_match");
  });

  it("prefers a standard egg carton when no count is requested", () => {
    const result = rankProducts("eggs", [
      candidate("six", "Great Value Large White Eggs, 6 Count", 0.96, {
        productType: "eggs",
      }),
      candidate("dozen", "Great Value Large White Eggs, 12 Count", 1.92, {
        productType: "eggs",
      }),
    ]);

    expect(result.recommended?.id).toBe("dozen");
  });
});
