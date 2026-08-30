import { describe, expect, it } from "vitest";
import { createMemoryStorageArea, JsonStateStore } from "../src/storage";

describe("extension storage abstraction", () => {
  it("recovers saved state through a new store instance", async () => {
    const area = createMemoryStorageArea();
    const first = new JsonStateStore(area, "cartiva.test", () => ({ list: "", progress: 0 }));
    await first.save({ list: "eggs\nmilk", progress: 1 });

    const reopened = new JsonStateStore(area, "cartiva.test", () => ({ list: "", progress: 0 }));
    await expect(reopened.load()).resolves.toEqual({ list: "eggs\nmilk", progress: 1 });
  });

  it("supports atomic-style updates and clear", async () => {
    const area = createMemoryStorageArea();
    const store = new JsonStateStore(area, "state", () => ({ count: 0 }));
    await store.update((current) => ({ count: current.count + 1 }));
    await expect(store.load()).resolves.toEqual({ count: 1 });
    await store.clear();
    await expect(store.load()).resolves.toEqual({ count: 0 });
  });
});
