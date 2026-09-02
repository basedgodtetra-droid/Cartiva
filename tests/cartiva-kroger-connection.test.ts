import { describe, expect, it } from "vitest";
import { getCartivaKrogerPreflight } from "@/lib/cartiva-kroger-connection";

describe("Cartiva Kroger connection preflight", () => {
  it("classifies a valid connection without requesting OAuth", () => {
    expect(getCartivaKrogerPreflight(true, { connected: true, configured: true }))
      .toMatchObject({ state: "connected", connected: true });
  });

  it("classifies a shopper who has never connected", () => {
    expect(getCartivaKrogerPreflight(true, { connected: false, configured: true }))
      .toMatchObject({ state: "required", connected: false });
  });

  it("keeps an expired connection distinct from a new connection", () => {
    expect(getCartivaKrogerPreflight(true, {
      connected: false,
      configured: true,
      expired: true,
    })).toMatchObject({ state: "expired", connected: false });
  });

  it("does not mistake an unavailable status check for an authentication failure", () => {
    expect(getCartivaKrogerPreflight(false, {
      configured: true,
      error: "Kroger is temporarily unavailable.",
    })).toMatchObject({ state: "unavailable", connected: false });
  });
});
