import { describe, expect, it } from "vitest";
import {
  krogerConnectionControl,
  krogerConnectionAfterCartTransferPhase,
  showKrogerDisconnectControl,
} from "@/mobile/src/services/kroger-connection-ui";

describe("Kroger connection control", () => {
  it("exposes a repair/reset path for connected or unverifiable saved state", () => {
    expect(showKrogerDisconnectControl("connected")).toBe(true);
    expect(showKrogerDisconnectControl("unavailable")).toBe(true);
    expect(showKrogerDisconnectControl("checking")).toBe(false);
    expect(showKrogerDisconnectControl("not_connected")).toBe(false);
    expect(krogerConnectionControl("connected")).toMatchObject({
      canRetry: false,
      canResetSession: false,
      resetLabel: "Disconnect / change account",
    });
    expect(krogerConnectionControl("unavailable")).toMatchObject({
      canRetry: true,
      canResetSession: true,
      resetLabel: "Reset saved Kroger connection",
    });
    expect(krogerConnectionControl("unavailable")?.detail).toContain("could not verify");
  });

  it("reveals disconnect after an in-place OAuth flow is authoritatively connected", () => {
    const connection = krogerConnectionAfterCartTransferPhase(
      "not_connected",
      "AUTHORIZATION_CONNECTED",
    );
    expect(connection).toBe("connected");
    expect(showKrogerDisconnectControl(connection)).toBe(true);
  });
});
