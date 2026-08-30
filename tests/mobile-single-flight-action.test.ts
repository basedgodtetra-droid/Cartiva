import { describe, expect, it } from "vitest";
import { createSingleFlightAction } from "@/mobile/src/services/single-flight-action";

describe("mobile single-flight action", () => {
  it("allows only one synchronous navigation until the screen regains focus", () => {
    const transition = createSingleFlightAction();
    expect(transition.tryStart()).toBe(true);
    expect(transition.tryStart()).toBe(false);
    expect(transition.active).toBe(true);

    transition.reset();
    expect(transition.tryStart()).toBe(true);
  });
});
