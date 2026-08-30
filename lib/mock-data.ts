import { extractMeasurement } from "./measurements";
import { inferProductCategory } from "./product-knowledge";
import type { WalmartProduct } from "./types";
import { createWalmartSearchUrl } from "./walmart-url";

const registry = new Map<string, WalmartProduct>();

function inferredBrand(title: string) {
  return [
    "Great Value", "Coca-Cola", "7UP", "Gatorade", "Pepsi", "Sprite",
    "Dr Pepper", "Mountain Dew", "Bimbo", "Takis", "Doritos", "Lay's",
    "Cheetos", "Oreo", "Chobani", "FAGE", "Oikos", "Barilla", "Goya",
    "Bush's", "Tyson", "Eggland's Best",
  ].find((brand) => title.toLowerCase().includes(brand.toLowerCase()));
}

function sampleProduct(
  id: string,
  title: string,
  price: number,
  options: Partial<WalmartProduct> = {},
): WalmartProduct {
  return {
    id,
    title,
    price,
    seller: "Sample Walmart data",
    brand: inferredBrand(title),
    productType: inferProductCategory(title),
    inStock: true,
    sponsored: false,
    size: extractMeasurement(title),
    link: createWalmartSearchUrl(title),
    linkType: "search",
    productPageUnavailable: true,
    dataSource: "mock",
    verification: "unverified",
    ...options,
  };
}

// Curated sample records only. Unknown requests intentionally receive no fabricated product.
const SAMPLE_RESULTS: Record<string, WalmartProduct[]> = {
  takis: [
    sampleProduct(
      "sample-takis-fuego",
      "Takis Fuego Hot Chili Pepper & Lime Flavored Rolled Tortilla Chips, 9.9 oz Bag",
      3.48,
      { brand: "Takis", productType: "snack chips" },
    ),
  ],
  bimbo: [
    sampleProduct(
      "sample-bimbo-mantecadas",
      "Bimbo Mantecadas Vanilla Mini Muffins, 8 Count",
      3.98,
      { brand: "Bimbo", productType: "snack cakes" },
    ),
  ],
  "7 up": [
    sampleProduct(
      "sample-7up-12",
      "7UP Lemon Lime Soda, 12 Pack, 12 fl oz Cans",
      7.97,
      { brand: "7UP", productType: "soda" },
    ),
    sampleProduct(
      "sample-7up-zero-12",
      "7UP Zero Sugar Lemon Lime Soda, 12 Pack, 12 fl oz Cans",
      7.97,
      { brand: "7UP", productType: "soda" },
    ),
  ],
  "coke zero": [
    sampleProduct(
      "sample-coke-zero-12",
      "Coca-Cola Zero Sugar Soda, 12 Pack, 12 fl oz Cans",
      8.98,
      { brand: "Coca-Cola", productType: "soda" },
    ),
  ],
  coke: [
    sampleProduct(
      "sample-coke-original-12",
      "Coca-Cola Original Taste Soda Pop, 12 Pack, 12 fl oz Cans",
      8.98,
      { brand: "Coca-Cola", productType: "soda" },
    ),
  ],
  cheese: [
    sampleProduct("sample-cheese-american", "Great Value Singles American Pasteurized Prepared Cheese Product, 16 oz, 24 Count", 2.48, {
      brand: "Great Value",
      productType: "cheese",
    }),
    sampleProduct("sample-cheese-cheddar", "Great Value Medium Cheddar Cheese Block, 8 oz", 1.97, {
      brand: "Great Value",
      productType: "cheese",
    }),
    sampleProduct("sample-cheese-swiss", "Sargento Sliced Swiss Natural Cheese, 11 Slices, 8 oz", 3.24, {
      brand: "Sargento",
      productType: "cheese",
    }),
  ],
  gatorade: [
    sampleProduct(
      "sample-gatorade-12",
      "Gatorade Lemon Lime Thirst Quencher, 12 Pack, 12 fl oz Bottles",
      8.78,
      {
        brand: "Gatorade",
        productType: "sports drink",
        reportedUnitPrice: Number((8.78 / 12).toFixed(4)),
        reportedUnitBasis: "each",
      },
    ),
    sampleProduct(
      "sample-gatorade-single",
      "Gatorade Lemon Lime Thirst Quencher, 12 fl oz Bottle",
      1.87,
      { brand: "Gatorade", productType: "sports drink" },
    ),
  ],
  cranberry: [
    sampleProduct("sample-cranberry-fresh", "Fresh Whole Cranberries, 12 oz Bag", 2.98),
    sampleProduct("sample-cranberry-juice", "Great Value Cranberry Juice Cocktail, 64 fl oz", 2.84),
    sampleProduct("sample-cranberry-dried", "Great Value Dried Cranberries, 5 oz", 2.46),
  ],
  bread: [
    sampleProduct("sample-bread-white", "Great Value White Sandwich Bread, 20 oz Loaf", 1.42),
    sampleProduct("sample-bread-wheat", "Great Value 100% Whole Wheat Bread, 20 oz Loaf", 1.87),
  ],
  eggs: [
    sampleProduct("sample-eggs-12", "Great Value Large White Eggs, 12 Count", 2.48),
    sampleProduct("sample-eggs-18", "Great Value Large White Eggs, 18 Count", 3.62),
    sampleProduct("sample-eggs-eb", "Eggland's Best Large White Eggs, 12 Count", 3.94),
  ],
  yogurt: [
    sampleProduct("sample-yogurt-gv", "Great Value Plain Nonfat Greek Yogurt, 32 oz Tub", 3.54),
    sampleProduct("sample-yogurt-chobani", "Chobani Plain Non-Fat Greek Yogurt, 32 oz Tub", 5.47),
    sampleProduct("sample-yogurt-fage", "FAGE Total 0% Plain Greek Yogurt, 32 oz Tub", 6.18),
    sampleProduct("sample-yogurt-cups", "Oikos Vanilla Greek Yogurt, 4 Pack, 5.3 oz Cups", 4.36),
  ],
  chicken: [
    sampleProduct("sample-chicken-gv", "Great Value Boneless Skinless Chicken Breasts, 3 lb Bag", 10.44),
    sampleProduct("sample-chicken-tyson", "Tyson Boneless Skinless Chicken Breasts, 2.5 lb", 12.48),
    sampleProduct("sample-chicken-family", "Fresh Family Pack Chicken Breast, 4.5 lb", 15.72),
  ],
  broccoli: [
    sampleProduct("sample-broccoli-crowns", "Fresh Broccoli Crowns, 1 lb", 1.64),
    sampleProduct("sample-broccoli-florets", "Marketside Broccoli Florets, 12 oz Bag", 2.48),
    sampleProduct("sample-broccoli-frozen", "Great Value Frozen Broccoli Florets, 12 oz", 1.16),
  ],
  pasta: [
    sampleProduct("sample-pasta-gv", "Great Value Spaghetti Pasta, 16 oz", 0.98),
    sampleProduct("sample-pasta-barilla", "Barilla Spaghetti Pasta, 16 oz Box", 1.84),
    sampleProduct("sample-pasta-penne", "Great Value Penne Pasta, 16 oz", 0.98),
  ],
  "black beans": [
    sampleProduct("sample-beans-gv", "Great Value Black Beans, 15 oz Can", 0.86),
    sampleProduct("sample-beans-bush", "Bush's Best Black Beans, 15 oz Can", 1.28),
    sampleProduct("sample-beans-goya", "Goya Black Beans, 15.5 oz Can", 1.42),
  ],
};

function register(products: WalmartProduct[]) {
  products.forEach((item) => registry.set(item.id, item));
  return products.map((item) => ({ ...item }));
}

export function getMockWalmartResults(query: string): WalmartProduct[] {
  const normalized = query.toLowerCase();
  const key = /\b7\s*up\b/i.test(normalized)
    ? "7 up"
    : Object.keys(SAMPLE_RESULTS).find((candidate) => normalized.includes(candidate));
  return register(key ? SAMPLE_RESULTS[key] : []);
}

export function getMockWalmartProductDetail(productId: string): WalmartProduct | null {
  const searchProduct = registry.get(productId)
    ?? Object.values(SAMPLE_RESULTS).flat().find((item) => item.id === productId);
  if (!searchProduct) return null;

  return {
    ...searchProduct,
    checkedAt: new Date().toISOString(),
    verification: "unverified",
  };
}
