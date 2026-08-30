import { comparableRetailers } from "@/lib/comparison-preview";

export type HeroDemoPhase =
  | "idle"
  | "typing"
  | "location"
  | "pressing"
  | "comparing"
  | "results"
  | "winner"
  | "complete"
  | "manual";

export type HeroDemoAction =
  | { at: number; kind: "phase"; phase: Exclude<HeroDemoPhase, "idle" | "manual"> }
  | { at: number; kind: "lines"; count: number }
  | { at: number; kind: "zip"; count: number }
  | { at: number; kind: "checks"; count: number }
  | { at: number; kind: "retailers"; count: number };

export const HERO_DEMO_ITEMS = [
  "Large eggs · 12 count",
  "2% milk · 1 gallon",
  "White bread · 20 oz",
  "Plain Greek yogurt · 32 oz",
  "Black beans · 15 oz",
] as const;

export const HERO_DEMO_CHECKS = [
  "Matching equivalent products",
  "Checking package sizes",
  "Building complete baskets",
  "Comparing totals",
] as const;

export const HERO_DEMO_TIMELINE: readonly HeroDemoAction[] = [
  { at: 0, kind: "phase", phase: "typing" },
  { at: 140, kind: "lines", count: 1 },
  { at: 440, kind: "lines", count: 2 },
  { at: 740, kind: "lines", count: 3 },
  { at: 1_040, kind: "lines", count: 4 },
  { at: 1_340, kind: "lines", count: 5 },
  { at: 1_600, kind: "phase", phase: "location" },
  { at: 1_740, kind: "zip", count: 1 },
  { at: 1_810, kind: "zip", count: 2 },
  { at: 1_880, kind: "zip", count: 3 },
  { at: 1_950, kind: "zip", count: 4 },
  { at: 2_020, kind: "zip", count: 5 },
  { at: 2_200, kind: "phase", phase: "pressing" },
  { at: 2_540, kind: "phase", phase: "comparing" },
  { at: 2_820, kind: "checks", count: 1 },
  { at: 3_130, kind: "checks", count: 2 },
  { at: 3_440, kind: "checks", count: 3 },
  { at: 3_750, kind: "checks", count: 4 },
  { at: 4_100, kind: "phase", phase: "results" },
  { at: 4_140, kind: "retailers", count: 1 },
  { at: 4_280, kind: "retailers", count: 2 },
  { at: 4_420, kind: "retailers", count: 3 },
  { at: 4_800, kind: "phase", phase: "winner" },
  { at: 5_500, kind: "phase", phase: "complete" },
] as const;

export const HERO_DEMO_DURATION_MS = HERO_DEMO_TIMELINE.at(-1)?.at ?? 0;

export function getHeroDemoSavingsCents() {
  const totals = comparableRetailers
    .map((retailer) => Math.round(retailer.total * 100))
    .sort((a, b) => a - b);

  return totals.length > 1 ? totals[1] - totals[0] : 0;
}
