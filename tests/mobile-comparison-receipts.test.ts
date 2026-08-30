import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { POST as authStartPost } from "@/app/api/mobile/v1/kroger/auth/start/route";
import { resetRateLimitsForTests } from "@/lib/api-security";
import { resetKrogerCartOperationsForTests } from "@/lib/kroger-cart-operations";
import {
  clearComparisonReceiptsForTests,
  ComparisonReceiptConflictError,
  ComparisonReceiptStateUnavailableError,
  loadComparisonReceipt,
  resetComparisonReceiptsForTests,
  saveComparisonReceipt,
} from "@/lib/mobile-comparison-receipts";
import { issueMobileSession, verifyMobileSessionToken } from "@/lib/mobile-session";
import {
  AvailabilityStatus,
  BasketCompleteness,
  type ComparisonSessionReceipt,
} from "@/packages/shared/src";

const ownerA = "a".repeat(64);
const ownerB = "b".repeat(64);

function receipt(
  locationId = "62000115",
  comparisonId = "cmp_owner_store_test",
): ComparisonSessionReceipt {
  return {
    schemaVersion: 1,
    comparisonId,
    retailer: "kroger",
    retailerChain: "KINGSOOPERS",
    retailerBanner: "King Soopers",
    locationId,
    locationName: "King Soopers - Union Station",
    locationAddress: "1950 Chestnut Pl, Denver, CO 80202",
    zipCode: "80202",
    fulfillmentMode: "pickup",
    requestedItemIds: ["bread"],
    basketLines: [{
      lineId: `${comparisonId}:bread`,
      requestedItemId: "bread",
      requestedItem: "bread",
      normalizedIntent: "bread",
      quantity: 1,
      status: "ACCEPTED",
      retailerProductId: "0001111008473",
      upc: "0001111008473",
      matchedProduct: "Kroger Classic White Sandwich Bread",
      matchedPackage: "20 oz",
      priceCents: 199,
      locationId,
      availabilityStatus: AvailabilityStatus.VERIFIED_IN_STOCK,
      matchConfidence: "high",
      provenance: {
        dataSource: "kroger_public_api",
        priceSource: "kroger_location_product",
        priceScope: "exact_store",
        priceReliability: "verified",
        exactStoreVerified: true,
        sourceLocationId: locationId,
        fulfillment: ["pickup"],
      },
    }],
    completeness: BasketCompleteness.COMPLETE,
    checkedAt: "2026-08-24T17:00:00.000Z",
    createdAt: "2026-08-24T17:00:00.000Z",
  };
}

beforeEach(() => {
  vi.stubEnv("CARTIVA_SESSION_SECRET", "test-only-mobile-session-secret-at-least-32-bytes");
  vi.stubEnv(
    "CARTIVA_COMPARISON_RECEIPT_FILE",
    path.join(tmpdir(), `cartiva-comparison-${crypto.randomUUID()}.json`),
  );
  resetComparisonReceiptsForTests();
  resetRateLimitsForTests();
});

afterEach(async () => {
  await clearComparisonReceiptsForTests();
  vi.unstubAllEnvs();
});

describe("owner-scoped immutable comparison receipts", () => {
  it("binds a persisted receipt to the owner derived from a signed mobile session", async () => {
    const issued = issueMobileSession();
    const verified = verifyMobileSessionToken(issued.sessionToken);
    expect(verified.ownerId).toBe(issued.ownerId);

    await saveComparisonReceipt(verified.ownerId, receipt());
    resetComparisonReceiptsForTests();

    expect(await loadComparisonReceipt(verified.ownerId, "cmp_owner_store_test"))
      .toMatchObject({ locationId: "62000115", retailerBanner: "King Soopers" });
  });

  it("survives an in-memory reset and remains isolated to its session owner", async () => {
    await saveComparisonReceipt(ownerA, receipt());
    resetComparisonReceiptsForTests();

    expect(await loadComparisonReceipt(ownerB, "cmp_owner_store_test")).toBeNull();
    expect(await loadComparisonReceipt(ownerA, "cmp_owner_store_test")).toMatchObject({
      retailerBanner: "King Soopers",
      locationId: "62000115",
      basketLines: [{ upc: "0001111008473", quantity: 1 }],
    });
  });

  it("does not let a comparison ID silently switch retailer locations", async () => {
    await saveComparisonReceipt(ownerA, receipt());
    const changed = receipt("62000001");
    changed.locationName = "King Soopers - Speer";
    await expect(saveComparisonReceipt(ownerA, changed))
      .rejects.toBeInstanceOf(ComparisonReceiptConflictError);
    expect((await loadComparisonReceipt(ownerA, changed.comparisonId))?.locationId)
      .toBe("62000115");
  });

  it("does not expose an undurable receipt to same-process reads or APIs", async () => {
    const issued = issueMobileSession();
    const durableFile = process.env.CARTIVA_COMPARISON_RECEIPT_FILE!;
    const durable = receipt("62000115", "cmp_durable_receipt_001");
    const undurable = receipt("62000115", "cmp_undurable_receipt_001");
    await saveComparisonReceipt(issued.ownerId, durable);

    const pathBlocker = path.join(
      tmpdir(),
      `cartiva-comparison-path-blocker-${crypto.randomUUID()}`,
    );
    await writeFile(pathBlocker, "This file prevents creation of a child receipt directory.");
    vi.stubEnv(
      "CARTIVA_COMPARISON_RECEIPT_FILE",
      path.join(pathBlocker, "receipts.json"),
    );
    const mobileStateRoot = path.join(
      tmpdir(),
      `cartiva-comparison-auth-${crypto.randomUUID()}`,
    );
    vi.stubEnv("CARTIVA_ENABLE_KROGER_CART_WRITES", "true");
    vi.stubEnv("KROGER_CLIENT_ID", "comparison-receipt-test-client");
    vi.stubEnv("KROGER_CLIENT_SECRET", "comparison-receipt-test-client-secret");
    vi.stubEnv(
      "KROGER_MOBILE_REDIRECT_URI",
      "https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback",
    );
    vi.stubEnv("CARTIVA_MOBILE_OAUTH_STATE_DIR", path.join(mobileStateRoot, "oauth-state"));
    vi.stubEnv("CARTIVA_MOBILE_OAUTH_COMPLETION_DIR", path.join(mobileStateRoot, "oauth-completion"));
    vi.stubEnv("CARTIVA_MOBILE_KROGER_SESSION_DIR", path.join(mobileStateRoot, "sessions"));
    vi.stubEnv("KROGER_CART_RECEIPT_FILE", path.join(mobileStateRoot, "cart-operations.json"));
    resetKrogerCartOperationsForTests();

    try {
      await expect(saveComparisonReceipt(issued.ownerId, undurable)).rejects.toBeDefined();

      expect(await loadComparisonReceipt(issued.ownerId, durable.comparisonId))
        .toMatchObject({ comparisonId: durable.comparisonId });
      expect(await loadComparisonReceipt(issued.ownerId, undurable.comparisonId)).toBeNull();

      const response = await authStartPost(new Request(
        "https://api.cartiva.test/api/mobile/v1/kroger/auth/start",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${issued.sessionToken}`,
            "Content-Type": "application/json",
            "X-Forwarded-For": "203.0.113.94",
          },
          body: JSON.stringify({ comparisonId: undurable.comparisonId }),
        },
      ));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "comparison_unavailable" });
    } finally {
      vi.stubEnv("CARTIVA_COMPARISON_RECEIPT_FILE", durableFile);
      resetComparisonReceiptsForTests();
      resetKrogerCartOperationsForTests();
      await rm(pathBlocker, { force: true });
      await rm(mobileStateRoot, { recursive: true, force: true });
    }
  });

  it("treats an unreadable receipt path as unavailable instead of an empty store", async () => {
    const file = process.env.CARTIVA_COMPARISON_RECEIPT_FILE!;
    await mkdir(file, { recursive: true });
    resetComparisonReceiptsForTests();

    try {
      await expect(loadComparisonReceipt(ownerA, "cmp_owner_store_test"))
        .rejects.toBeInstanceOf(ComparisonReceiptStateUnavailableError);
      await expect(saveComparisonReceipt(ownerA, receipt()))
        .rejects.toBeInstanceOf(ComparisonReceiptStateUnavailableError);
    } finally {
      resetComparisonReceiptsForTests();
      await rm(file, { recursive: true, force: true });
    }
  });

  it.each([
    ["invalid JSON", "{not-json"],
    ["a non-array top level", JSON.stringify({ receipts: [] })],
  ])("fails closed for %s without overwriting the durable file", async (_label, serialized) => {
    const file = process.env.CARTIVA_COMPARISON_RECEIPT_FILE!;
    await writeFile(file, serialized, "utf8");
    resetComparisonReceiptsForTests();

    await expect(saveComparisonReceipt(ownerA, receipt()))
      .rejects.toBeInstanceOf(ComparisonReceiptStateUnavailableError);
    expect(await readFile(file, "utf8")).toBe(serialized);
  });

  it("rejects one malformed active record instead of silently dropping it", async () => {
    const file = process.env.CARTIVA_COMPARISON_RECEIPT_FILE!;
    await saveComparisonReceipt(ownerA, receipt());
    const stored = JSON.parse(await readFile(file, "utf8")) as Array<Record<string, unknown>>;
    stored[0]!.fingerprint = "invalid-fingerprint";
    const malformed = JSON.stringify(stored);
    await writeFile(file, malformed, "utf8");
    resetComparisonReceiptsForTests();

    await expect(loadComparisonReceipt(ownerA, "cmp_owner_store_test"))
      .rejects.toBeInstanceOf(ComparisonReceiptStateUnavailableError);
    await expect(saveComparisonReceipt(ownerA, receipt()))
      .rejects.toBeInstanceOf(ComparisonReceiptStateUnavailableError);
    expect(await readFile(file, "utf8")).toBe(malformed);
  });

  it("fails closed before parsing an oversized receipt file", async () => {
    const file = process.env.CARTIVA_COMPARISON_RECEIPT_FILE!;
    await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    resetComparisonReceiptsForTests();

    await expect(loadComparisonReceipt(ownerA, "cmp_owner_store_test"))
      .rejects.toBeInstanceOf(ComparisonReceiptStateUnavailableError);
  });

  it("rejects a receipt file above the strict record ceiling before iterating entries", async () => {
    const file = process.env.CARTIVA_COMPARISON_RECEIPT_FILE!;
    await writeFile(file, JSON.stringify(new Array(4_097).fill(null)), "utf8");
    resetComparisonReceiptsForTests();

    await expect(loadComparisonReceipt(ownerA, "cmp_owner_store_test"))
      .rejects.toBeInstanceOf(ComparisonReceiptStateUnavailableError);
  });

  it("prunes expired receipts before enforcing capacity and publishing a new map", async () => {
    const file = process.env.CARTIVA_COMPARISON_RECEIPT_FILE!;
    await saveComparisonReceipt(ownerA, receipt("62000115", "cmp_expired_receipt"));
    const expired = JSON.parse(await readFile(file, "utf8")) as Array<Record<string, unknown>>;
    expired[0]!.expiresAt = 1;
    await writeFile(file, JSON.stringify(expired), "utf8");
    resetComparisonReceiptsForTests();

    await saveComparisonReceipt(ownerA, receipt("62000115", "cmp_current_receipt"));
    const persisted = JSON.parse(await readFile(file, "utf8")) as Array<{
      receipt: ComparisonSessionReceipt;
    }>;
    expect(persisted.map((entry) => entry.receipt.comparisonId)).toEqual(["cmp_current_receipt"]);
  });

  it("rejects a new receipt at capacity without changing the durable file", async () => {
    const file = process.env.CARTIVA_COMPARISON_RECEIPT_FILE!;
    const expiresAt = Date.now() + 60_000;
    const full = Array.from({ length: 4_096 }, (_, index) => {
      const comparisonId = `cmp_capacity_${index}`;
      const storedReceipt = receipt("62000115", comparisonId);
      return {
        ownerId: ownerA,
        fingerprint: createHash("sha256")
          .update(JSON.stringify(storedReceipt))
          .digest("base64url"),
        receipt: storedReceipt,
        expiresAt,
      };
    });
    const original = JSON.stringify(full);
    expect(Buffer.byteLength(original)).toBeLessThan(8 * 1024 * 1024);
    await writeFile(file, original, "utf8");
    resetComparisonReceiptsForTests();

    await expect(saveComparisonReceipt(
      ownerA,
      receipt("62000115", "cmp_capacity_overflow"),
    )).rejects.toBeInstanceOf(ComparisonReceiptStateUnavailableError);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await loadComparisonReceipt(ownerA, "cmp_capacity_overflow")).toBeNull();
  });
});
