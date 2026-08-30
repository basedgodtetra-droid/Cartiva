export const siteConfig = {
  name: "Cartiva",
  tagline: "One list. Only complete cart comparisons.",
  description:
    "An independent grocery comparison assistant that matches one list across nearby retailers, compares only complete baskets, and sends shoppers to the retailer to check out.",
  sampleList: `eggs
plain Greek yogurt 32 oz
chicken breast 3 lb
broccoli 1 lb
pasta 16 oz
black beans 15 oz`,
  searchConcurrency: 5,
  verificationConcurrency: 4,
  cacheTtlMs: 30 * 60 * 1000,
  detailCacheTtlMs: 45 * 60 * 1000,
} as const;
