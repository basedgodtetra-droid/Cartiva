import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mobileSessionFetch: vi.fn(),
}));

vi.mock("../mobile/src/services/mobile-session", () => ({
  mobileSessionFetch: mocks.mobileSessionFetch,
}));

import {
  CartivaApiError,
  searchKroger,
  type KrogerSearchRequest,
} from "../mobile/src/services/cartiva-api";

const request: KrogerSearchRequest = {
  comparisonId: "comparison_stream_timeout_01",
  items: [{
    text: "milk",
    requestedItemId: "requested_milk_01",
    quantity: 1,
  }],
  locationId: "62000115",
  zipCode: "80202",
  fulfillmentMode: "pickup",
};

function searchErrorEvent(cartAutomationEnabled: boolean) {
  return {
    type: "item",
    retailer: "kroger",
    phase: "search",
    index: 0,
    mode: "live",
    checkedAt: "2026-08-24T18:00:00.000Z",
    cartAutomation: cartAutomationEnabled
      ? { enabled: true, requiresCustomerConnection: true }
      : { enabled: false, reason: "Cart transfer is unavailable on the anonymous API." },
    result: {
      retailer: "kroger",
      requestedItem: "milk",
      recommended: null,
      alternatives: [],
      confidence: "low",
      status: "review",
      explanation: "Checking Kroger.",
      error: "Kroger is still checking this item.",
    },
    diagnostics: {
      searchResultCount: 0,
      verificationStatus: "needs_review",
      locationId: "62000115",
      rejectionReason: "Checking Kroger.",
    },
  };
}

function responseThatStallsAfterOneEvent(cartAutomationEnabled: boolean) {
  const cancel = vi.fn();
  const event = searchErrorEvent(cartAutomationEnabled);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
      // Deliberately leave the stream open with no further bytes.
    },
    cancel,
  });
  return {
    cancel,
    response: new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }),
  };
}

beforeEach(() => {
  vi.stubGlobal("__DEV__", true);
  mocks.mobileSessionFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([
  { label: "anonymous comparison", persistServerReceipt: false },
  { label: "temporary-session comparison", persistServerReceipt: true },
])("mobile Kroger NDJSON timeout: $label", ({ persistServerReceipt }) => {
  it("aborts and cancels a response that sends one event and then stalls", async () => {
    const stalled = responseThatStallsAfterOneEvent(persistServerReceipt);
    let signal: AbortSignal | undefined;
    const responder = vi.fn(async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return stalled.response;
    });
    if (persistServerReceipt) {
      mocks.mobileSessionFetch.mockImplementation(responder);
    } else {
      vi.stubGlobal("fetch", responder);
    }
    const onEvent = vi.fn();

    const settled = searchKroger(request, onEvent, {
      persistServerReceipt,
      timeoutMs: 30,
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    const result = await settled;

    expect(result.value).toBeUndefined();
    expect(result.error).toBeInstanceOf(CartivaApiError);
    expect(result.error).toMatchObject({ code: "timeout" });
    expect(signal?.aborted).toBe(true);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
  });

  it("aborts a superseded stream immediately without converting cancellation to timeout", async () => {
    const stalled = responseThatStallsAfterOneEvent(persistServerReceipt);
    const consumer = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const responder = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return stalled.response;
    });
    if (persistServerReceipt) {
      mocks.mobileSessionFetch.mockImplementation(responder);
    } else {
      vi.stubGlobal("fetch", responder);
    }
    const onEvent = vi.fn();
    const settled = searchKroger(request, onEvent, {
      persistServerReceipt,
      timeoutMs: 10_000,
      signal: consumer.signal,
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    consumer.abort();
    const result = await settled;

    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({ name: "AbortError" });
    expect(result.error).not.toBeInstanceOf(CartivaApiError);
    expect(requestSignal?.aborted).toBe(true);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed item event before publishing it to the app", async () => {
    const event = searchErrorEvent(persistServerReceipt);
    event.diagnostics.locationId = "different-store";
    const response = new Response(`${JSON.stringify(event)}\n`, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
    const responder = vi.fn(async () => response);
    if (persistServerReceipt) mocks.mobileSessionFetch.mockImplementation(responder);
    else vi.stubGlobal("fetch", responder);
    const onEvent = vi.fn();

    await expect(searchKroger(request, onEvent, {
      persistServerReceipt,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "response" });
    expect(onEvent).not.toHaveBeenCalled();
  });
});
