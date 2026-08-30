import { describe, expect, it } from "vitest";

import {
  getHeroDemoSavingsCents,
  HERO_DEMO_DURATION_MS,
  HERO_DEMO_ITEMS,
  HERO_DEMO_TIMELINE,
} from "../lib/home-hero-demo";

describe("homepage product demonstration", () => {
  it("uses the requested five-item fixed example", () => {
    expect(HERO_DEMO_ITEMS).toEqual([
      "Large eggs · 12 count",
      "2% milk · 1 gallon",
      "White bread · 20 oz",
      "Plain Greek yogurt · 32 oz",
      "Black beans · 15 oz",
    ]);
  });

  it("moves through the intended state machine once in 5.5 seconds", () => {
    const phases = HERO_DEMO_TIMELINE.flatMap((action) =>
      action.kind === "phase" ? [action.phase] : [],
    );

    expect(phases).toEqual([
      "typing",
      "location",
      "pressing",
      "comparing",
      "results",
      "winner",
      "complete",
    ]);
    expect(HERO_DEMO_DURATION_MS).toBe(5_500);
    expect(phases.filter((phase) => phase === "complete")).toHaveLength(1);
  });

  it("keeps every scheduled action monotonic and the retailer stagger quick", () => {
    const times = HERO_DEMO_TIMELINE.map((action) => action.at);
    const retailerTimes = HERO_DEMO_TIMELINE.flatMap((action) =>
      action.kind === "retailers" ? [action.at] : [],
    );

    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(retailerTimes).toEqual([4_140, 4_280, 4_420]);
    expect(retailerTimes[1] - retailerTimes[0]).toBe(140);
    expect(retailerTimes[2] - retailerTimes[1]).toBe(140);
  });

  it("derives the approved $1.55 savings instead of inventing a value", () => {
    expect(getHeroDemoSavingsCents()).toBe(155);
  });

  it("contains presentation actions only, with no submit or request action", () => {
    const actionKinds = HERO_DEMO_TIMELINE.map((action) => action.kind);

    expect(actionKinds).not.toContain("submit");
    expect(actionKinds).not.toContain("request");
    expect(actionKinds).not.toContain("navigate");
  });
});
