import { describe, expect, it } from "vitest";
import {
  analyzeProductFacets,
  buildFacetSearchQuery,
  buildWalmartSearchQuery,
  productConstraintIssues,
  selectFacetOption,
} from "@/lib/product-facets";

function groupIds(text: string, selectedOptionIds: string[] = []) {
  return analyzeProductFacets(text, selectedOptionIds).groups.map((group) => group.id);
}

function optionLabels(text: string, selectedOptionIds: string[] = []) {
  return analyzeProductFacets(text, selectedOptionIds).groups.flatMap((group) =>
    group.options.map((option) => option.label),
  );
}

function constraintValues(text: string, selectedOptionIds: string[] = []) {
  return Object.fromEntries(
    analyzeProductFacets(text, selectedOptionIds).constraints.map((constraint) => [
      constraint.attribute,
      { value: constraint.value, source: constraint.source },
    ]),
  );
}

describe("category-specific product facets", () => {
  it("recognizes Sprite as soda and preserves its typed brand", () => {
    const request = analyzeProductFacets("Sprite");

    expect(request.category).toBe("soda");
    expect(request.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: "brand", value: "sprite", source: "typed" }),
    ]));
    expect(request.groups.map((group) => group.id)).not.toContain("soda-brand");
    expect(optionLabels("Sprite")).toEqual(expect.arrayContaining([
      "12-pack cans",
      "2-liter bottle",
      "6-pack bottles",
      "Mini cans",
    ]));
  });

  it("offers bread-specific types, styles, brands, and optional loaf sizes", () => {
    const request = analyzeProductFacets("bread");

    expect(request.category).toBe("bread");
    expect(request.constraints.map((constraint) => constraint.attribute)).not.toContain("dietary");
    expect(request.groups.map((group) => group.id)).toEqual([
      "bread-type",
      "bread-dietary",
      "bread-brand",
      "bread-size",
    ]);
    expect(optionLabels("bread")).toEqual(expect.arrayContaining([
      "White",
      "Wheat",
      "Whole grain",
      "Buns",
      "Tortillas",
      "Gluten free",
      "20 oz loaf",
    ]));

    const typed = analyzeProductFacets("whole grain bread");
    expect(typed.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: "breadType", value: "whole-grain", source: "typed" }),
    ]));
    expect(typed.groups.map((group) => group.id)).not.toContain("bread-type");

    const namedBrand = analyzeProductFacets("Bimbo bread");
    expect(namedBrand.constraints).toContainEqual(
      expect.objectContaining({ attribute: "brand", value: "bimbo", source: "typed" }),
    );
    expect(namedBrand.groups.map((group) => group.id)).not.toContain("bread-brand");

    const dietary = analyzeProductFacets("gluten-free white bread");
    expect(dietary.constraints).toContainEqual(expect.objectContaining({
      attribute: "dietary",
      value: "gluten-free",
      source: "typed",
    }));
    expect(dietary.groups.map((group) => group.id)).not.toContain("bread-dietary");

    const selectedDietary = analyzeProductFacets(
      "white bread",
      ["bread-dietary-gluten-free"],
    );
    expect(selectedDietary.constraints).toContainEqual(expect.objectContaining({
      attribute: "dietary",
      value: "gluten-free",
      source: "selected",
    }));
    expect(buildFacetSearchQuery("white bread", selectedDietary.constraints))
      .toBe("white bread Gluten free");
  });

  it("does not ask for a chicken cut that the user already supplied", () => {
    const request = analyzeProductFacets("chicken breast");

    expect(request.category).toBe("chicken");
    expect(request.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: "cut", value: "breast", source: "typed" }),
    ]));
    expect(request.groups.map((group) => group.id)).not.toContain("chicken-cut");
    expect(optionLabels("chicken breast")).toEqual(expect.arrayContaining([
      "Boneless skinless",
      "Bone-in",
      "Fresh",
      "Frozen",
      "Family pack",
    ]));

    const detailed = analyzeProductFacets("frozen boneless skinless chicken breast");
    expect(groupIds("frozen boneless skinless chicken breast")).not.toEqual(
      expect.arrayContaining(["chicken-cut", "chicken-prep", "chicken-state"]),
    );
    expect(detailed.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: "cut", value: "breast", source: "typed" }),
      expect.objectContaining({ attribute: "boneStyle", value: "boneless", source: "typed" }),
      expect.objectContaining({ attribute: "skinStyle", value: "skinless", source: "typed" }),
      expect.objectContaining({ attribute: "temperature", value: "frozen", source: "typed" }),
    ]));
  });

  it("preserves typed milk fat and container size", () => {
    const request = analyzeProductFacets("2% milk half gallon");

    expect(request.category).toBe("milk");
    expect(request.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: "fatPercentage", value: "2-percent", source: "typed" }),
      expect.objectContaining({ attribute: "containerSize", value: "half-gallon", source: "typed" }),
    ]));
    expect(request.groups.map((group) => group.id)).not.toEqual(
      expect.arrayContaining(["milk-fat", "milk-size"]),
    );
    expect(optionLabels("milk")).toEqual(expect.arrayContaining([
      "Whole",
      "2%",
      "Skim",
      "Almond",
      "Gallon",
      "Half gallon",
    ]));
  });

  it("recognizes Takis as chips and does not ask for typed brand, flavor, or bag size", () => {
    const request = analyzeProductFacets("Takis Fuego 9.9 oz");

    expect(request.category).toBe("chips");
    expect(request.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: "brand", value: "takis", source: "typed" }),
      expect.objectContaining({ attribute: "flavor", value: "fuego", source: "typed" }),
      expect.objectContaining({ attribute: "bagSize", value: "standard", source: "typed" }),
    ]));
    expect(request.groups.map((group) => group.id)).not.toEqual(
      expect.arrayContaining(["chips-brand", "chips-flavor", "chips-size"]),
    );
    expect(request.groups.map((group) => group.id)).toContain("chips-pack");
  });

  it("offers dairy-cheese choices without treating Doritos as cheese", () => {
    const request = analyzeProductFacets("cheese");
    expect(request.category).toBe("cheese");
    expect(optionLabels("cheese")).toEqual(expect.arrayContaining([
      "American",
      "Cheddar",
      "Swiss",
      "Mozzarella",
      "Slices",
      "Shredded",
      "Block",
    ]));

    const typed = analyzeProductFacets("Swiss cheese slices");
    expect(typed.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: "cheeseType", value: "swiss", source: "typed" }),
      expect.objectContaining({ attribute: "packageForm", value: "slices", source: "typed" }),
    ]));
    expect(analyzeProductFacets("Doritos nacho cheese").category).toBe("chips");
  });

  it("offers regular Coke as an explicit variety while preserving the Coca-Cola brand", () => {
    const request = analyzeProductFacets("Coke");
    expect(request.category).toBe("soda");
    expect(request.constraints).toContainEqual(
      expect.objectContaining({ attribute: "brand", value: "coca cola", source: "typed" }),
    );
    expect(optionLabels("Coke")).toContain("Original");
  });

  it.each([
    ["tuna", "canned-seafood", ["Chunk light", "Albacore", "Water", "Oil"]],
    ["juice", "juice", ["Apple", "Orange", "Cranberry"]],
    ["pasta", "pasta", ["Spaghetti", "Penne", "Gluten free"]],
    ["rice", "rice", ["White", "Brown", "Jasmine", "Basmati"]],
    ["beans", "beans", ["Black", "Pinto", "Kidney", "Chickpeas"]],
    ["bacon", "bacon", ["Regular cut", "Thick cut", "Turkey bacon"]],
  ])("offers relevant options for %s", (text, category, labels) => {
    expect(analyzeProductFacets(text).category).toBe(category);
    expect(optionLabels(text)).toEqual(expect.arrayContaining(labels));
  });

  it("recognizes a typed dozen as the egg count", () => {
    const request = analyzeProductFacets("one dozen eggs");

    expect(request.category).toBe("eggs");
    expect(request.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: "count", value: "12", source: "typed" }),
    ]));
    expect(request.groups.map((group) => group.id)).not.toContain("eggs-count");
    expect(request.groups.map((group) => group.id)).toContain("eggs-type");
  });

  it("extracts typed produce variety, quantity, and bag format", () => {
    const request = analyzeProductFacets("Honeycrisp apples 3 lb bag");

    expect(request.category).toBe("produce");
    expect(request.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: "variety", value: "honeycrisp", source: "typed" }),
      expect.objectContaining({ attribute: "quantity", value: "3-lb", source: "typed" }),
      expect.objectContaining({ attribute: "packageType", value: "bag", source: "typed" }),
    ]));
    expect(request.groups.map((group) => group.id)).toEqual(["produce-state"]);

    expect(optionLabels("apples")).toEqual(expect.arrayContaining([
      "Honeycrisp",
      "Fuji",
      "Gala",
      "1 lb",
      "3 lb",
      "Bag",
      "Individual",
    ]));
  });

  it.each([
    "produce",
    "vegetables",
    "asparagus",
    "bell peppers",
    "peppers",
    "cucumber",
    "zucchini",
    "squash",
    "cauliflower",
    "celery",
    "cilantro",
    "parsley",
    "basil",
  ])("recognizes %s as produce", (text) => {
    expect(analyzeProductFacets(text).category).toBe("produce");
  });

  it("offers state and concrete vegetable choices for broad produce requests", () => {
    const request = analyzeProductFacets("vegetables");

    expect(request.groups.map((group) => group.id)).toEqual(expect.arrayContaining([
      "produce-type",
      "produce-state",
    ]));
    expect(optionLabels("vegetables")).toEqual(expect.arrayContaining([
      "Broccoli",
      "Asparagus",
      "Carrots",
      "Tomatoes",
      "Bell peppers",
      "Cucumber",
      "Zucchini",
      "Cauliflower",
      "Spinach",
      "Fresh",
      "Frozen",
      "Canned",
    ]));
    expect(groupIds("broccoli")).not.toContain("produce-type");
    expect(groupIds("broccoli")).toContain("produce-state");
  });

  it("shows no facets for an unknown product", () => {
    const request = analyzeProductFacets("birthday candles");

    expect(request.category).toBeUndefined();
    expect(request).toMatchObject({
      constraints: [],
      selectedOptionIds: [],
      groups: [],
    });
  });
});

describe("facet selection and structured Walmart constraints", () => {
  it("builds concise live Walmart queries without synthetic UI wording", () => {
    expect(buildWalmartSearchQuery(analyzeProductFacets(
      "Takis Fuego standard 23 bag",
    ))).toBe("Takis Fuego Chips");
    expect(buildWalmartSearchQuery(analyzeProductFacets(
      "Coca-Cola Original 12 pack cans",
    ))).toBe("Coca-Cola Soda 12-pack Cans");
    expect(buildWalmartSearchQuery(analyzeProductFacets(
      "large brown eggs 12 count",
    ))).toBe("Large brown Eggs 12 count");
    expect(buildWalmartSearchQuery(analyzeProductFacets(
      "Diet Coke",
    ))).toBe("Coca-Cola Diet Soda");
  });

  it("keeps typed retailer wording intact and only appends deliberately selected facets", () => {
    const diet = analyzeProductFacets("Diet Coke");
    expect(diet.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: "brand", value: "coca cola", source: "typed" }),
      expect.objectContaining({ attribute: "flavor", value: "diet", source: "typed" }),
    ]));
    expect(buildFacetSearchQuery(diet.text, diet.constraints)).toBe("Diet Coke");

    const selected = selectFacetOption("Sprite", [], "soda-format-12-cans");
    const sprite = analyzeProductFacets("Sprite", selected);
    expect(buildFacetSearchQuery(sprite.text, sprite.constraints)).toBe("Sprite 12-pack Cans");
  });

  it("defaults concrete produce searches to fresh without overriding an explicit form", () => {
    expect(buildWalmartSearchQuery(analyzeProductFacets("broccoli"))).toBe("fresh broccoli");
    expect(buildWalmartSearchQuery(analyzeProductFacets("asparagus"))).toBe("fresh asparagus");
    expect(buildWalmartSearchQuery(analyzeProductFacets("tomatoes"))).toBe("fresh tomatoes");
    expect(buildWalmartSearchQuery(analyzeProductFacets("frozen broccoli"))).toBe("frozen broccoli");
    expect(buildWalmartSearchQuery(analyzeProductFacets("canned asparagus"))).toBe("canned asparagus");
    expect(buildWalmartSearchQuery(analyzeProductFacets("pickled asparagus"))).toBe("pickled asparagus");
    expect(buildWalmartSearchQuery(analyzeProductFacets("dried tomatoes"))).toBe("dried tomatoes");
    expect(buildWalmartSearchQuery(analyzeProductFacets("cilantro"))).toBe("fresh cilantro");
    expect(buildWalmartSearchQuery(analyzeProductFacets("parsley"))).toBe("fresh parsley");
    expect(buildWalmartSearchQuery(analyzeProductFacets("basil"))).toBe("fresh basil");
    expect(buildWalmartSearchQuery(analyzeProductFacets("dried cilantro"))).toBe("dried cilantro");
    expect(buildWalmartSearchQuery(analyzeProductFacets("produce"))).toBe("produce");
    expect(buildWalmartSearchQuery(analyzeProductFacets("vegetables"))).toBe("vegetables");
  });

  it("turns broad produce chips into a concrete state-aware Walmart query", () => {
    const asparagus = selectFacetOption("vegetables", [], "produce-type-asparagus");
    expect(buildWalmartSearchQuery(analyzeProductFacets("vegetables", asparagus))).toBe(
      "fresh asparagus",
    );

    const frozen = selectFacetOption("vegetables", asparagus, "produce-state-frozen");
    const request = analyzeProductFacets("vegetables", frozen);
    expect(request.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: "produceType", value: "asparagus", source: "selected" }),
      expect.objectContaining({ attribute: "produceState", value: "frozen", source: "selected" }),
    ]));
    expect(buildWalmartSearchQuery(request)).toBe("frozen asparagus");
  });

  it("offers fresh-or-dried facets for culinary herbs", () => {
    const request = analyzeProductFacets("cilantro");
    expect(request.groups.find((group) => group.id === "produce-state")?.options).toEqual([
      expect.objectContaining({ label: "Fresh" }),
      expect.objectContaining({ label: "Dried" }),
    ]);
  });

  it("treats an unmodified named soda as original when Walmart omits that word", () => {
    const constraints = analyzeProductFacets("Coca-Cola Original 12 pack cans").constraints;
    const regular = {
      title: "Coca-Cola Soda Pop Cans, 12 fl oz, 12 Pack",
      brand: "Coca-Cola",
      productType: "soda",
    };
    const zero = {
      title: "Coca-Cola Zero Sugar Soda Pop Cans, 12 fl oz, 12 Pack",
      brand: "Coca-Cola",
      productType: "soda",
    };

    expect(productConstraintIssues(regular, constraints)).toEqual([]);
    expect(productConstraintIssues(zero, constraints)).toContain("does not match Original");
  });

  it("turns a composite soda chip into pack and container constraints", () => {
    const selected = selectFacetOption("Sprite", [], "soda-format-12-cans");
    const request = analyzeProductFacets("Sprite", selected);

    expect(selected).toEqual(["soda-format-12-cans"]);
    expect(request.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: "brand", value: "sprite", source: "typed" }),
      expect.objectContaining({ attribute: "packCount", value: "12", source: "selected" }),
      expect.objectContaining({ attribute: "containerFormat", value: "cans", source: "selected" }),
    ]));
    expect(buildFacetSearchQuery(request.text, request.constraints)).toBe("Sprite 12-pack Cans");
  });

  it("accepts an exact pack proven by retailer metadata when the title omits the pack count", () => {
    const constraints = analyzeProductFacets("Coke Zero, 12 pack").constraints;
    const exactPack = {
      title: "Coca-Cola Zero Sugar Soda Cans",
      brand: "Coca-Cola",
      productType: "Beverages",
      size: {
        amount: 144,
        unit: "fl oz" as const,
        kind: "volume" as const,
        baseAmount: 144,
        baseUnit: "fl oz" as const,
        packCount: 12,
        perPackageAmount: 12,
        label: "12 × 12 fl oz",
      },
    };

    expect(productConstraintIssues(exactPack, constraints)).toEqual([]);
    expect(productConstraintIssues({
      ...exactPack,
      size: { ...exactPack.size, packCount: 24, amount: 288, baseAmount: 288, label: "24 × 12 fl oz" },
    }, constraints)).toContain("does not match 12-pack");
  });

  it("allows only one conflicting common soda format", () => {
    const cans = selectFacetOption("Sprite", [], "soda-format-12-cans");
    const bottle = selectFacetOption("Sprite", cans, "soda-format-2-liter");

    expect(bottle).toEqual(["soda-format-2-liter"]);
    const request = analyzeProductFacets("Sprite", bottle);
    expect(buildFacetSearchQuery(request.text, request.constraints)).toBe("Sprite 2-liter Bottle");
  });

  it("treats Auto as clearing selected options without deleting typed constraints", () => {
    const selected = analyzeProductFacets("Sprite", ["soda-format-12-cans"]);
    expect(selected.constraints.some((constraint) => constraint.source === "selected")).toBe(true);

    const automatic = analyzeProductFacets("Sprite", []);
    expect(automatic.selectedOptionIds).toEqual([]);
    expect(automatic.constraints).toEqual([
      expect.objectContaining({ attribute: "brand", value: "sprite", source: "typed" }),
    ]);
    expect(buildFacetSearchQuery(automatic.text, automatic.constraints)).toBe("Sprite");
  });

  it("never lets a conflicting selected brand override a typed named brand", () => {
    const request = analyzeProductFacets("Sprite", ["soda-brand-coca-cola"]);

    expect(constraintValues("Sprite", ["soda-brand-coca-cola"]).brand).toEqual({
      value: "sprite",
      source: "typed",
    });
    expect(buildFacetSearchQuery(request.text, request.constraints)).toBe("Sprite");
  });

  it("makes a selected named brand a strict product constraint", () => {
    const request = analyzeProductFacets("soda", ["soda-brand-sprite"]);
    const goodProduct = {
      title: "Sprite Lemon Lime Soda, 12 Pack Cans",
      brand: "Sprite",
      productType: "soda",
    };
    const storeBrand = {
      title: "Great Value Lemon Lime Soda, 12 Pack Cans",
      brand: "Great Value",
      productType: "soda",
    };

    expect(buildFacetSearchQuery(request.text, request.constraints)).toBe("soda Sprite");
    expect(productConstraintIssues(goodProduct, request.constraints)).toEqual([]);
    expect(productConstraintIssues(storeBrand, request.constraints)).toContain(
      "does not match Sprite",
    );
  });
});

describe("category false-positive guards", () => {
  it.each([
    "chicken broth",
    "milk chocolate",
    "egg noodles",
    "coffee creamer",
  ])("does not show grocery facets for %s", (text) => {
    expect(analyzeProductFacets(text).category).toBeUndefined();
    expect(analyzeProductFacets(text).groups).toEqual([]);
  });
});

describe("protein product constraints", () => {
  it.each([
    ["93/7 ground beef 2 lb", "meat", "leanRatio", "93/7"],
    ["boneless skinless chicken breast", "chicken", "cut", "breast"],
    ["ribeye steak", "meat", "cut", "ribeye"],
    ["pork chops", "meat", "cut", "chops"],
    ["salmon fillet", "seafood", "species", "salmon"],
    ["jumbo raw shrimp", "seafood", "cookingState", "raw"],
    ["ground turkey 93/7", "turkey", "leanRatio", "93/7"],
    ["italian sausage", "sausage", "sausageKind", "italian"],
  ])("structures %s as strict protein intent", (text, category, attribute, value) => {
    const request = analyzeProductFacets(text);
    expect(request.category).toBe(category);
    expect(request.constraints).toContainEqual(expect.objectContaining({
      attribute,
      value,
      source: "typed",
    }));
  });

  it("recognizes retailer lean-ratio wording as equivalent but rejects a different ratio", () => {
    const constraints = analyzeProductFacets("93/7 ground beef").constraints;
    const percentTitle = {
      title: "Kroger Lean Ground Beef 93% Lean 1 lb Tray",
      productType: "ground beef",
      brand: "Kroger",
    };
    const wrongRatio = {
      ...percentTitle,
      title: "Kroger Ground Beef 80/20 1 lb Tray",
    };

    expect(productConstraintIssues(percentTitle, constraints)).toEqual([]);
    expect(productConstraintIssues(wrongRatio, constraints)).toContain("does not match 93/7");
  });

  it("keeps a supplied protein attribute out of the remaining facet groups", () => {
    expect(groupIds("ribeye steak")).not.toContain("steak-cut");
    expect(groupIds("93/7 ground beef")).not.toContain("ground-meat-ratio");
    expect(groupIds("salmon fillet")).not.toEqual(expect.arrayContaining(["seafood-species", "seafood-form"]));
    expect(groupIds("boneless skinless chicken breast")).not.toEqual(
      expect.arrayContaining(["chicken-cut", "chicken-prep"]),
    );
  });
});
