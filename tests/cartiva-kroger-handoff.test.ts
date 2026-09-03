import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCartivaKrogerHandoffStage } from "@/lib/cartiva-kroger-handoff";

describe("Cartiva Kroger handoff state", () => {
  it("stops at a shopper-reviewable Cartiva basket after comparison", () => {
    expect(getCartivaKrogerHandoffStage({
      basketComplete: true,
      cartPhase: "idle",
    })).toBe("basket_ready");
  });

  it("keeps authorization, cart writing, and retailer-confirmed success distinct", () => {
    expect(getCartivaKrogerHandoffStage({
      basketComplete: true,
      cartPhase: "authorizing",
    })).toBe("authorizing");
    expect(getCartivaKrogerHandoffStage({
      basketComplete: true,
      cartPhase: "adding",
    })).toBe("adding");
    expect(getCartivaKrogerHandoffStage({
      basketComplete: true,
      cartPhase: "success",
    })).toBe("transfer_success");
    expect(getCartivaKrogerHandoffStage({
      basketComplete: true,
      cartPhase: "reviewed",
    })).toBe("review_complete");
  });

  it("returns cancelled or failed authorization to the preserved Cartiva basket", () => {
    expect(getCartivaKrogerHandoffStage({
      basketComplete: true,
      cartPhase: "error",
      cartCode: "oauth_cancelled",
    })).toBe("oauth_cancelled");
    expect(getCartivaKrogerHandoffStage({
      basketComplete: true,
      cartPhase: "error",
      cartCode: "oauth_failed",
    })).toBe("oauth_failed");
  });

  it("keeps never-connected and expired authentication distinct", () => {
    expect(getCartivaKrogerHandoffStage({
      basketComplete: true,
      cartPhase: "error",
      cartCode: "auth_required",
    })).toBe("auth_required");
    expect(getCartivaKrogerHandoffStage({
      basketComplete: true,
      cartPhase: "error",
      cartCode: "auth_expired",
    })).toBe("auth_expired");
  });

  it("performs a fresh auth preflight before the authenticated cart write", () => {
    const source = readFileSync(path.join(process.cwd(), "components", "cartiva-workspace.tsx"), "utf8");
    const handoffBlock = source.slice(
      source.indexOf("const addToKroger = async"),
      source.indexOf("const resumeConnectedBasket = async"),
    );
    expect(handoffBlock.indexOf("await checkKrogerConnection()"))
      .toBeLessThan(handoffBlock.indexOf("await completePendingCart(pending)"));
    expect(handoffBlock).toContain("authWindow.location.replace(cartUrl)");
  });

  it("does not mistake the active same-tab cart request for an interrupted handoff", () => {
    const source = readFileSync(path.join(process.cwd(), "components", "cartiva-workspace.tsx"), "utf8");
    const resumeBlock = source.slice(
      source.indexOf("const resumeConnectedBasket = async"),
      source.indexOf("const resolveCartReview"),
    );
    const submittedCheck = resumeBlock.indexOf("if (pending.submittedAt !== undefined)");
    const handoffGuard = resumeBlock.indexOf("if (handoffAttemptRef.current === pending.operationId) return;");
    const transferGuard = resumeBlock.indexOf("if (cartTransferRef.current === pending.operationId) return;");
    const submittedBranchEnd = resumeBlock.indexOf("\n        return;", submittedCheck);
    expect(submittedCheck).toBeGreaterThanOrEqual(0);
    expect(handoffGuard).toBeGreaterThanOrEqual(0);
    expect(transferGuard).toBeGreaterThanOrEqual(0);
    expect(submittedBranchEnd).toBeGreaterThan(submittedCheck);
    expect(handoffGuard).toBeLessThan(submittedCheck);
    expect(transferGuard).toBeLessThan(submittedCheck);
    expect(resumeBlock.slice(submittedCheck, submittedBranchEnd)).toContain("await completePendingCart(pending)");
    expect(resumeBlock).not.toContain('window.addEventListener("storage", resumeConnectedBasket)');
  });

  it("keeps comparison free of popup, OAuth-start, and pending-transfer side effects", () => {
    const source = readFileSync(path.join(process.cwd(), "components", "cartiva-workspace.tsx"), "utf8");
    const comparisonBlock = source.slice(
      source.indexOf("const runComparison = async"),
      source.indexOf("const addToKroger = async"),
    );
    expect(comparisonBlock).not.toContain("window.open");
    expect(comparisonBlock).not.toContain("/api/kroger/oauth/start");
    expect(comparisonBlock).not.toContain("createPendingKrogerCart");
    expect(comparisonBlock).toContain("clearPendingKrogerCartBeforeBasketChange");
  });
});
