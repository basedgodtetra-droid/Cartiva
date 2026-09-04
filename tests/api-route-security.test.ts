import { describe, expect, it } from "vitest";
import { POST as walmartSearch } from "@/app/api/search/route";
import { POST as targetSearch } from "@/app/api/target/search/route";
import { POST as krogerSearch } from "@/app/api/kroger/search/route";
import { POST as krogerCart } from "@/app/api/kroger/cart/route";

function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("API route tamper resistance", () => {
  it("rejects non-JSON and cross-origin requests before provider work", async () => {
    const wrongType = new Request("http://127.0.0.1:3000/api/search", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect((await walmartSearch(wrongType)).status).toBe(415);

    const crossOrigin = request(
      "/api/search",
      { items: ["eggs"], storeId: "2201" },
      { Origin: "https://attacker.example" },
    );
    expect((await walmartSearch(crossOrigin)).status).toBe(403);
  });

  it("rejects partial-basket coercion, excess items, and unknown fields", async () => {
    const malformedItem = await walmartSearch(request("/api/search", {
      items: ["eggs", { text: "", quantity: "2" }],
      storeId: "2201",
    }));
    expect(malformedItem.status).toBe(400);

    const tooMany = await targetSearch(request("/api/target/search", {
      retailer: "target",
      items: Array.from({ length: 51 }, () => "eggs"),
      storeId: "1234",
      zipCode: "79912",
      fulfillmentMode: "pickup",
    }));
    expect(tooMany.status).toBe(400);

    const unknownField = await krogerSearch(request("/api/kroger/search", {
      retailer: "kroger",
      items: ["eggs"],
      locationId: "AB12CD34",
      fulfillmentMode: "pickup",
      userId: "someone-else",
    }));
    expect(unknownField.status).toBe(400);
  });

  it("rejects invalid fulfillment modes instead of silently defaulting", async () => {
    expect((await walmartSearch(request("/api/search", {
      items: ["eggs"],
      storeId: "2201",
      fulfillmentMode: "instant",
    })))).toHaveProperty("status", 400);

    expect((await targetSearch(request("/api/target/search", {
      items: ["eggs"],
      storeId: "1234",
      zipCode: "79912",
      fulfillmentMode: "instant",
    })))).toHaveProperty("status", 400);
  });

  it("rejects duplicate Kroger UPCs and mass-assignment fields", async () => {
    const duplicate = await krogerCart(request("/api/kroger/cart", {
      operationId: "secure_cart_build_0001",
      locationId: "AB12CD34",
      fulfillmentMode: "pickup",
      items: [
        { upc: "0001111012345", quantity: 1 },
        { upc: "0001111012345", quantity: 99 },
      ],
    }));
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ retrySafe: true });

    const tampered = await krogerCart(request("/api/kroger/cart", {
      operationId: "secure_cart_build_0002",
      locationId: "AB12CD34",
      fulfillmentMode: "pickup",
      items: [{ upc: "0001111012345", quantity: 1, price: 0.01 }],
    }));
    expect(tampered.status).toBe(400);
    expect(await tampered.json()).toMatchObject({ retrySafe: true });
  });
});
