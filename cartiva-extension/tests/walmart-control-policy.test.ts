import { describe, expect, it } from "vitest";
import "../src/walmart-control-policy";

const policy = (globalThis as typeof globalThis & {
  CartivaWalmartControlPolicy: CartivaWalmartControlPolicyApi;
}).CartivaWalmartControlPolicy;

const candidate = (
  overrides: Partial<CartivaWalmartControlCandidate> = {},
): CartivaWalmartControlCandidate => ({
  label: "Add to cart",
  disabled: false,
  ariaDisabled: false,
  inRecommendation: false,
  inPrimaryRoot: true,
  explicitControlSelector: true,
  associatedItemIds: [],
  ...overrides,
});

const choose = (candidates: CartivaWalmartControlCandidate[], kind: CartivaWalmartControlKind = "add") =>
  policy.chooseCandidate({
    kind,
    itemId: "145051970",
    exactTitle: "Great Value Large White Eggs, 12 Count",
    pageTitleMatches: true,
    candidates,
  });

describe("Walmart primary product control policy", () => {
  it.each([
    ["10840 Martin Luther King Jr Blvd, El Paso, TX 79934", "79934"],
    ["951 N Resler Dr, El Paso, TX 79912-1234", "79912"],
    ["700 Lafayette Rd, Seabrook, NH 03874", "03874"],
    ["200 Short Blvd, Dallas, TX 75232, USA", "75232"],
  ])("extracts the terminal US postal code from %s", (address, expected) => {
    expect(policy.postalCodeFromUsAddress(address)).toBe(expected);
  });

  it.each([
    "10840 Martin Luther King Jr Blvd",
    "Walmart Store #12345",
    "Pickup at Store 3014",
  ])("does not mistake a street or store number for a ZIP in %s", (address) => {
    expect(policy.postalCodeFromUsAddress(address)).toBeUndefined();
  });

  it("accepts Walmart's generic primary Add labels", () => {
    expect(choose([candidate({ label: "Add" })])).toBe(0);
    expect(choose([candidate({ label: "Add to cart" })])).toBe(0);
  });

  it("rejects recommendation, disabled and unrelated-product controls", () => {
    expect(choose([candidate({ inRecommendation: true })])).toBeUndefined();
    expect(choose([candidate({ disabled: true })])).toBeUndefined();
    expect(choose([candidate({ ariaDisabled: true })])).toBeUndefined();
    expect(choose([candidate({ associatedItemIds: ["999999999"] })])).toBeUndefined();
  });

  it("never mistakes Add to list or Add to registry for the cart CTA", () => {
    expect(choose([candidate({ label: "Add to list" })])).toBeUndefined();
    expect(choose([candidate({ label: "Add to registry" })])).toBeUndefined();
  });

  it("prefers a control explicitly tied to the current item", () => {
    expect(choose([
      candidate({ inPrimaryRoot: false, associatedItemIds: [] }),
      candidate({ inPrimaryRoot: false, associatedItemIds: ["145051970"] }),
    ])).toBe(1);
  });

  it("fails closed for an unverified page or ambiguous ungrounded controls", () => {
    expect(policy.chooseCandidate({
      kind: "add",
      itemId: "145051970",
      exactTitle: "Great Value Large White Eggs, 12 Count",
      pageTitleMatches: false,
      candidates: [candidate()],
    })).toBeUndefined();
    expect(choose([
      candidate({ inPrimaryRoot: false, explicitControlSelector: false }),
      candidate({ inPrimaryRoot: false, explicitControlSelector: false }),
    ])).toBeUndefined();
  });

  it("supports a generic exact-product quantity control", () => {
    expect(choose([candidate({ label: "Increase quantity" })], "increment")).toBe(0);
  });
});
