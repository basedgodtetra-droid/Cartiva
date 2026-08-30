import { describe, expect, it } from "vitest";
import "../src/target-control-policy";

const policy = (globalThis as typeof globalThis & {
  CartivaTargetControlPolicy: CartivaTargetControlPolicyApi;
}).CartivaTargetControlPolicy;

const candidate = (
  overrides: Partial<CartivaTargetControlCandidate> = {},
): CartivaTargetControlCandidate => ({
  label: "Add to cart for Grade A Large Eggs - 12ct - Good & Gather",
  disabled: false,
  ariaDisabled: false,
  inRecommendation: false,
  inPrimaryRoot: true,
  explicitControlSelector: true,
  fulfillmentModes: ["pickup"],
  ...overrides,
});

const choose = (
  candidates: CartivaTargetControlCandidate[],
  fulfillmentMode: CartivaTargetFulfillmentMode = "pickup",
) => policy.chooseCandidate({
  kind: "add",
  tcin: "14713534",
  exactTitle: "Grade A Large Eggs - 12ct - Good & Gather",
  pageTitleMatches: true,
  fulfillmentMode,
  candidates,
});

describe("Target visible-control policy", () => {
  it("recognizes Target's live aria-label selection without mistaking unselected", () => {
    expect(policy.fulfillmentCellIsSelected({
      ariaLabel: "pickup - selected - 1 of 3 - Get it today",
    })).toBe(true);
    expect(policy.fulfillmentCellIsSelected({
      ariaLabel: "delivery - unselected - 2 of 3 - Get it today",
    })).toBe(false);
    expect(policy.fulfillmentCellIsSelected({ ariaSelected: "true" })).toBe(true);
  });

  it("requires the exact visible Target pickup store ID", () => {
    expect(policy.visiblePickupStoreMatches("822", "store-name-822")).toBe(true);
    expect(policy.visiblePickupStoreMatches("822", "store-name-3014")).toBe(false);
    expect(policy.visiblePickupStoreMatches(undefined, "store-name-822")).toBe(false);
    expect(policy.visiblePickupStoreMatches("822", "other-822")).toBe(false);
  });

  it("accepts the exact primary Target pickup Add control", () => {
    expect(choose([candidate()])).toBe(0);
  });

  it("requires the requested fulfillment mode and never maps delivery to pickup", () => {
    expect(choose([candidate()], "delivery")).toBeUndefined();
    expect(choose([
      candidate({ fulfillmentModes: ["pickup"] }),
      candidate({ label: "Add", fulfillmentModes: ["delivery"] }),
    ], "delivery")).toBe(1);
  });

  it("rejects recommendations, disabled controls, lists and registries", () => {
    expect(choose([candidate({ inRecommendation: true })])).toBeUndefined();
    expect(choose([candidate({ disabled: true })])).toBeUndefined();
    expect(choose([candidate({ ariaDisabled: true })])).toBeUndefined();
    expect(choose([candidate({ label: "Add to registry" })])).toBeUndefined();
    expect(choose([candidate({ label: "Add to list" })])).toBeUndefined();
  });

  it("fails closed when the canonical TCIN page or exact title is not verified", () => {
    expect(policy.chooseCandidate({
      kind: "add",
      tcin: "14713534",
      exactTitle: "Eggs",
      pageTitleMatches: false,
      fulfillmentMode: "pickup",
      candidates: [candidate()],
    })).toBeUndefined();
    expect(policy.chooseCandidate({
      kind: "add",
      tcin: "not-a-tcin",
      exactTitle: "Eggs",
      pageTitleMatches: true,
      fulfillmentMode: "pickup",
      candidates: [candidate()],
    })).toBeUndefined();
  });
});
