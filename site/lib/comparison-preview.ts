export type MatchQuality = "Exact size" | "Equivalent" | "Uncertain";

export type PreviewItem = {
  request: string;
  match: string;
  size: string;
  price?: number;
  quality: MatchQuality;
  note?: string;
};

export type ComparableRetailer = {
  id: "walmart" | "king-soopers";
  name: string;
  status: "comparable";
  total: number;
  source: "Official retailer API" | "Third-party data";
  sourceDetail: string;
  scope: string;
  handoffUrl: string;
  handoffLabel: string;
  items: PreviewItem[];
};

export type ExcludedRetailer = {
  id: "target";
  name: string;
  status: "excluded";
  source: "Third-party data";
  sourceDetail: string;
  scope: string;
  matchedCount: number;
  requestedCount: number;
  exclusionReason: string;
  items: PreviewItem[];
};

export const PREVIEW_ZIP = "80202";

export const PREVIEW_LIST = [
  "large eggs, 12 count",
  "2% milk, 1 gallon",
  "white sandwich bread, 20 oz",
  "plain Greek yogurt, 32 oz",
  "black beans, 15 oz",
].join("\n");

export const comparableRetailers: ComparableRetailer[] = [
  {
    id: "walmart",
    name: "Walmart",
    status: "comparable",
    total: 11.4,
    source: "Third-party data",
    sourceDetail: "Independent provider data; not verified by Walmart.",
    scope: "Localized estimate for the 80202 area",
    handoffUrl: "https://www.walmart.com/",
    handoffLabel: "Continue at Walmart",
    items: [
      {
        request: "Large eggs, 12 count",
        match: "Great Value large white eggs",
        size: "12 count",
        price: 2.18,
        quality: "Exact size",
      },
      {
        request: "2% milk, 1 gallon",
        match: "Great Value 2% reduced-fat milk",
        size: "1 gallon",
        price: 3.04,
        quality: "Exact size",
      },
      {
        request: "White sandwich bread, 20 oz",
        match: "Great Value white sandwich bread",
        size: "20 oz",
        price: 1.42,
        quality: "Exact size",
      },
      {
        request: "Plain Greek yogurt, 32 oz",
        match: "Great Value plain nonfat Greek yogurt",
        size: "32 oz",
        price: 3.36,
        quality: "Equivalent",
      },
      {
        request: "Black beans, 15 oz",
        match: "Great Value black beans",
        size: "15 oz",
        price: 1.4,
        quality: "Exact size",
      },
    ],
  },
  {
    id: "king-soopers",
    name: "King Soopers",
    status: "comparable",
    total: 12.95,
    source: "Official retailer API",
    sourceDetail: "Product and price data returned by Kroger's official API.",
    scope: "Exact selected King Soopers store in 80202",
    handoffUrl: "https://www.kingsoopers.com/",
    handoffLabel: "Continue at King Soopers",
    items: [
      {
        request: "Large eggs, 12 count",
        match: "Kroger large white eggs",
        size: "12 count",
        price: 2.49,
        quality: "Exact size",
      },
      {
        request: "2% milk, 1 gallon",
        match: "Kroger 2% reduced-fat milk",
        size: "1 gallon",
        price: 3.49,
        quality: "Exact size",
      },
      {
        request: "White sandwich bread, 20 oz",
        match: "Kroger enriched white bread",
        size: "20 oz",
        price: 1.69,
        quality: "Equivalent",
      },
      {
        request: "Plain Greek yogurt, 32 oz",
        match: "Kroger plain nonfat Greek yogurt",
        size: "32 oz",
        price: 3.79,
        quality: "Equivalent",
      },
      {
        request: "Black beans, 15 oz",
        match: "Kroger black beans",
        size: "15 oz",
        price: 1.49,
        quality: "Exact size",
      },
    ],
  },
];

export const excludedRetailer: ExcludedRetailer = {
  id: "target",
  name: "Target",
  status: "excluded",
  source: "Third-party data",
  sourceDetail: "Independent provider data; not verified by Target.",
  scope: "Localized estimate for the 80202 area",
  matchedCount: 4,
  requestedCount: 5,
  exclusionReason:
    "The available yogurt match is 24 oz, not the requested 32 oz. Cartiva will not treat that uncertain substitution as a complete basket.",
  items: [
    {
      request: "Large eggs, 12 count",
      match: "Good & Gather large eggs",
      size: "12 count",
      quality: "Exact size",
    },
    {
      request: "2% milk, 1 gallon",
      match: "Good & Gather 2% milk",
      size: "1 gallon",
      quality: "Exact size",
    },
    {
      request: "White sandwich bread, 20 oz",
      match: "Market Pantry white bread",
      size: "20 oz",
      quality: "Equivalent",
    },
    {
      request: "Plain Greek yogurt, 32 oz",
      match: "Good & Gather plain Greek yogurt",
      size: "24 oz",
      quality: "Uncertain",
      note: "Package size does not meet the request.",
    },
    {
      request: "Black beans, 15 oz",
      match: "Good & Gather black beans",
      size: "15 oz",
      quality: "Exact size",
    },
  ],
};

export const loadingStages = [
  {
    label: "Finding retailers for the preview area",
    detail: "Checking which example stores serve ZIP 80202.",
  },
  {
    label: "Matching equivalent products",
    detail: "Comparing product type, brand flexibility, and package size.",
  },
  {
    label: "Checking basket completeness",
    detail: "Removing any basket with a missing or uncertain item.",
  },
  {
    label: "Preparing the complete-cart comparison",
    detail: "Ranking only the example baskets that passed every check.",
  },
] as const;
