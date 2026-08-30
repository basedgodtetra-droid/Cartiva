(() => {
  type FulfillmentMode = "pickup" | "delivery" | "shipping" | "unknown";
  type AddResult = {
    status: "added" | "needs_choice" | "unavailable" | "failed";
    message: string;
    baselineCartCount?: number;
  };
  type StoreOption = {
    id: string;
    name: string;
    address: string;
    zip: string;
    distance?: string;
    selected: boolean;
  };

  interface RetailerPageAdapter {
    getContext(): {
      onWalmart: boolean;
      storeId?: string;
      storeName?: string;
      address?: string;
      zip?: string;
      fulfillmentMode: FulfillmentMode;
      pageType: "home" | "search" | "product" | "cart" | "other";
    };
    addProduct(itemId: string, productId: string | undefined, exactTitle: string, quantity: number): Promise<AddResult>;
    verifyManualAdd(
      exactTitle: string,
      expectedQuantity: number,
      baselineCartCount?: number,
    ): { added: boolean; message: string };
    getPickupStores(): Promise<{ stores: StoreOption[] }>;
    selectPickupStore(storeId: string): Promise<{ store: StoreOption; selected: boolean; message: string }>;
    setFulfillment(mode: "pickup" | "delivery"): Promise<{ confirmed: boolean; message: string }>;
  }

  // Walmart changes markup frequently. Every selector used by the adapter lives here.
  const WALMART_SELECTORS = {
    locationTrigger: ["button[data-automation-id='fulfillment-banner']"],
    locationAddress: ["[data-automation-id='fulfillment-address']"],
    storeDetailLinks: [
      "a[link-identifier='storeDetails'][href^='/store/']",
      "a[aria-label^='Store details'][href^='/store/']",
    ],
    storeSelectionButtons: ["button[role='checkbox'][aria-label]"],
    fulfillmentDialog: ["[role='dialog']"],
    fulfillmentButtons: [
      "button[aria-label='Pickup']",
      "button[aria-label='Delivery']",
      "button[aria-label='Shipping']",
    ],
    cartButton: ["button[data-automation-id='cart-button-header']"],
    productTitle: [
      "h1[itemprop='name']",
      "h1[data-automation-id='product-title']",
      "main h1",
    ],
    productDetailRoot: [
      "main [data-testid='add-to-cart-section']",
      "main [data-testid='atc-buynow-container']",
      "main [data-testid='ip-atc-mweb-fixed']",
    ],
    addButtons: [
      "button[data-automation-id='atc']",
      "button[data-automation-id='add-to-cart']",
      "button[data-testid='add-to-cart']",
      "button[aria-label^='Add to cart' i]",
    ],
    quantityIncrease: [
      "button[data-testid='quantity-stepper-inc-button']",
      "button[aria-label*='Increase quantity' i]",
    ],
    successStatus: ["[role='status']", "[data-testid*='toast']", "[data-automation-id*='toast']"],
    optionControls: ["[role='dialog'] input", "[role='dialog'] select", "[role='dialog'] [role='radio']"],
    loginGate: [
      "[role='dialog'] form[action*='login' i]",
      "[role='dialog'] input[type='password']",
      "main form[action*='login' i] input[type='password']",
    ],
    captchaGate: ["iframe[src*='captcha' i]", "[data-testid*='captcha' i]", "[id*='captcha' i]"],
    recommendationRegion: [
      "[data-testid*='carousel' i]",
      "[data-automation-id*='carousel' i]",
      "[data-testid*='horizontal-scroller' i]",
      "[data-automation-id*='horizontal-scroller' i]",
      "[data-testid*='recommend' i]",
      "[data-automation-id*='recommend' i]",
      "section[aria-label*='recommend' i]",
      "section[aria-label*='customers' i]",
      "section[aria-label*='similar' i]",
      "section[aria-label*='related' i]",
    ],
  } as const;

  function firstVisible(selectors: readonly string[], root: ParentNode = document) {
    for (const selector of selectors) {
      for (const element of root.querySelectorAll<HTMLElement>(selector)) {
        if (element.getClientRects().length && getComputedStyle(element).visibility !== "hidden") return element;
      }
    }
    return undefined;
  }

  function allVisible(selectors: readonly string[], root: ParentNode = document) {
    return selectors.flatMap((selector) => [...root.querySelectorAll<HTMLElement>(selector)])
      .filter((element, index, values) => values.indexOf(element) === index)
      .filter((element) => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
  }

  function normalize(value: string) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function titleMatches(expected: string, actual: string) {
    const expectedTitle = normalize(expected);
    const actualTitle = normalize(actual);
    return expectedTitle.length >= 4
      && actualTitle.length >= 4
      && (actualTitle.includes(expectedTitle) || expectedTitle.includes(actualTitle));
  }

  function cartCount() {
    const label = firstVisible(WALMART_SELECTORS.cartButton)?.getAttribute("aria-label") ?? "";
    const match = label.match(/cart\s+contains\s+(\d+)\s+items?/i) ?? label.match(/(\d+)\s+items?/i);
    return match ? Number(match[1]) : undefined;
  }

  function pageType() {
    if (location.pathname === "/" || location.pathname === "") return "home" as const;
    if (location.pathname.startsWith("/search")) return "search" as const;
    if (location.pathname.startsWith("/ip/")) return "product" as const;
    if (location.pathname.startsWith("/cart")) return "cart" as const;
    return "other" as const;
  }

  function selectedFulfillment(): FulfillmentMode {
    const selected = allVisible(WALMART_SELECTORS.fulfillmentButtons)
      .find((button) => button.getAttribute("aria-pressed") === "true" || button.getAttribute("aria-selected") === "true");
    const value = selected?.getAttribute("aria-label")?.toLowerCase();
    if (value === "pickup" || value === "delivery" || value === "shipping") return value;
    const intent = pageLocationMetadata()?.intent?.toUpperCase();
    if (intent === "PICKUP") return "pickup";
    if (intent === "DELIVERY") return "delivery";
    if (intent === "SHIPPING") return "shipping";
    const bannerText = firstVisible(WALMART_SELECTORS.locationTrigger)?.textContent?.toLowerCase() ?? "";
    const found = (["pickup", "delivery", "shipping"] as const).filter((mode) => bannerText.includes(mode));
    return found.length === 1 ? found[0] : "unknown";
  }

  function locationText() {
    const addressNodes = allVisible(WALMART_SELECTORS.locationAddress);
    const storeAddress = addressNodes.find((node) => /supercenter/i.test(node.textContent ?? ""))
      ?? addressNodes[0];
    return storeAddress?.textContent?.replace(/\s+/g, " ").trim()
      ?? firstVisible(WALMART_SELECTORS.locationTrigger)?.textContent?.replace(/\s+/g, " ").trim()
      ?? "";
  }

  function parsedLocationText(raw: string) {
    const segments = raw.split(/[•·|]/).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
    const storeSegment = [...segments].reverse().find((part) => /supercenter/i.test(part))
      ?? (/supercenter/i.test(raw) ? raw : "");
    const storeName = storeSegment.match(/([a-z0-9][a-z0-9 .'-]{1,70}?supercenter)\b/i)?.[1]?.trim();
    const pickupMentions = raw.match(/pickup or delivery/gi)?.length ?? 0;
    const zipMentions = raw.match(/\b\d{5}(?:-\d{4})?\b/g)?.length ?? 0;
    const address = raw.length <= 180 && pickupMentions <= 1 && zipMentions <= 1
      ? raw.replace(/\s+/g, " ").trim()
      : undefined;
    return { storeName, address };
  }

  function storeCardFor(link: Element) {
    let current: HTMLElement | null = link.parentElement;
    while (current && current !== document.body) {
      if (
        current.querySelector("h3")
        && current.querySelector("button[role='checkbox'][aria-label]")
        && current.querySelector("a[href^='/store/']")
      ) return current;
      current = current.parentElement;
    }
    return undefined;
  }

  function pickupStoreOptions() {
    const stores: StoreOption[] = [];
    const seen = new Set<string>();
    for (const link of allVisible(WALMART_SELECTORS.storeDetailLinks)) {
      const href = link.getAttribute("href") ?? "";
      const id = href.match(/^\/store\/(\d{1,8})(?:[/?#]|$)/)?.[1];
      if (!id || seen.has(id)) continue;
      const card = storeCardFor(link);
      if (!card) continue;
      const name = card.querySelector("h3")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const paragraphs = [...card.querySelectorAll("p")]
        .map((entry) => entry.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean);
      const address = paragraphs.find((entry) =>
        Boolean(CartivaWalmartControlPolicy.postalCodeFromUsAddress(entry)) && !/#\d+\b/.test(entry)) ?? "";
      const zip = CartivaWalmartControlPolicy.postalCodeFromUsAddress(address) ?? "";
      const selector = card.querySelector<HTMLButtonElement>("button[role='checkbox'][aria-label]");
      const distanceLink = [...card.querySelectorAll<HTMLAnchorElement>("a")]
        .find((entry) => /miles? away/i.test(entry.getAttribute("aria-label") ?? entry.textContent ?? ""));
      const distance = distanceLink?.textContent?.replace(/\s+/g, " ").trim()
        || distanceLink?.getAttribute("aria-label")?.match(/\b\d+(?:\.\d+)?\s+miles?\s+away\b/i)?.[0];
      if (!name || !address || !zip || !selector) continue;
      seen.add(id);
      stores.push({
        id,
        name,
        address,
        zip,
        distance: distance || undefined,
        selected: selector.getAttribute("aria-checked") === "true" || /\bmy store\b/i.test(card.textContent ?? ""),
      });
    }
    return stores.slice(0, 10);
  }

  function pageLocationMetadata(): {
    storeId?: string;
    pickupStore?: string;
    deliveryStore?: string;
    postalCode?: string;
    intent?: string;
  } | undefined {
    const serialized = document.querySelector<HTMLScriptElement>("#__NEXT_DATA__[type='application/json']")?.textContent;
    if (!serialized) return undefined;
    try {
      const parsed = JSON.parse(serialized) as {
        props?: { pageProps?: {
          initialTempoData?: { data?: { contentLayout?: {
            pageMetadata?: { location?: Record<string, unknown> };
          } } };
          initialData?: {
            pageMetadata?: { location?: Record<string, unknown> };
            contentLayout?: { pageMetadata?: { location?: Record<string, unknown> } };
            data?: {
              contentLayout?: { pageMetadata?: { location?: Record<string, unknown> } };
              product?: { location?: Record<string, unknown> };
            };
          };
        } };
      };
      const pageProps = parsed.props?.pageProps;
      const location = pageProps?.initialTempoData?.data?.contentLayout?.pageMetadata?.location
        ?? pageProps?.initialData?.pageMetadata?.location
        ?? pageProps?.initialData?.contentLayout?.pageMetadata?.location
        ?? pageProps?.initialData?.data?.contentLayout?.pageMetadata?.location
        ?? pageProps?.initialData?.data?.product?.location;
      if (!location) return undefined;
      const read = (key: string) => {
        const value = location[key];
        return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
      };
      return {
        storeId: read("storeId"),
        pickupStore: read("pickupStore"),
        deliveryStore: read("deliveryStore"),
        postalCode: read("postalCode"),
        intent: read("intent"),
      };
    } catch {
      return undefined;
    }
  }

  function preferredContextStoreId(
    mode: FulfillmentMode,
    metadata: ReturnType<typeof pageLocationMetadata>,
    visibleStoreIds: Array<string | undefined>,
  ) {
    const valid = (value?: string | null) => value && /^\d{1,8}$/.test(value)
      ? value
      : undefined;
    const visible = visibleStoreIds.map(valid).find(Boolean);
    if (visible) return visible;
    const modeSpecific = mode === "pickup"
      ? metadata?.pickupStore
      : mode === "delivery"
        ? metadata?.deliveryStore
        : undefined;
    const scoped = valid(modeSpecific);
    if (scoped) return scoped;
    return mode === "unknown" ? valid(metadata?.storeId) : undefined;
  }

  function getStoreId() {
    const metadata = pageLocationMetadata();
    return preferredContextStoreId(selectedFulfillment(), metadata, [
      new URL(location.href).searchParams.get("store_id") ?? undefined,
      pickupStoreOptions().find((store) => store.selected)?.id,
      firstVisible(WALMART_SELECTORS.locationTrigger)?.getAttribute("data-store-id") ?? undefined,
      document.documentElement.getAttribute("data-store-id") ?? undefined,
    ]);
  }

  function isInsideRecommendation(element: Element) {
    return WALMART_SELECTORS.recommendationRegion.some((selector) => Boolean(element.closest(selector)));
  }

  function matchingControlButton(
    kind: CartivaWalmartControlKind,
    itemId: string,
    exactTitle: string,
  ) {
    const pageTitle = firstVisible(WALMART_SELECTORS.productTitle)?.textContent ?? "";
    const roots = allVisible(WALMART_SELECTORS.productDetailRoot);
    const selectors = kind === "add" ? WALMART_SELECTORS.addButtons : WALMART_SELECTORS.quantityIncrease;
    const buttons = roots.flatMap((root) => allVisible(selectors, root))
      .filter((button, index, values) => values.indexOf(button) === index) as HTMLButtonElement[];
    const candidates = buttons.map((button): CartivaWalmartControlCandidate => ({
      label: button.getAttribute("aria-label") ?? button.textContent ?? "",
      disabled: button.disabled,
      ariaDisabled: button.getAttribute("aria-disabled") === "true",
      inRecommendation: isInsideRecommendation(button),
      inPrimaryRoot: true,
      explicitControlSelector: true,
      associatedItemIds: [],
    }));
    const index = CartivaWalmartControlPolicy.chooseCandidate({
      kind,
      itemId,
      exactTitle,
      pageTitleMatches: titleMatches(exactTitle, pageTitle),
      candidates,
    });
    return index === undefined ? undefined : buttons[index];
  }

  function matchingAddButton(itemId: string, exactTitle: string) {
    return matchingControlButton("add", itemId, exactTitle);
  }

  function matchingIncrementButton(itemId: string, exactTitle: string) {
    return matchingControlButton("increment", itemId, exactTitle);
  }

  async function waitForMatchingAddButton(itemId: string, exactTitle: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const button = matchingAddButton(itemId, exactTitle);
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
      if (hasSecurityGate()) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return undefined;
  }

  function stepperQuantity(button?: HTMLElement) {
    const label = button?.getAttribute("aria-label") ?? "";
    const match = label.match(/current\s+quantity\D+(\d+)/i) ?? label.match(/quantity\D+(\d+)/i);
    return match ? Number(match[1]) : undefined;
  }

  async function waitForStepperQuantity(itemId: string, exactTitle: string, previousQuantity?: number) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const quantity = stepperQuantity(matchingIncrementButton(itemId, exactTitle));
      if (quantity !== undefined && previousQuantity !== undefined && quantity > previousQuantity) return quantity;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return undefined;
  }

  function hasSecurityGate() {
    return Boolean(firstVisible(WALMART_SELECTORS.loginGate) || firstVisible(WALMART_SELECTORS.captchaGate));
  }

  function hasRequiredChoice() {
    const dialog = firstVisible(WALMART_SELECTORS.fulfillmentDialog);
    if (!dialog) return false;
    return Boolean(firstVisible(WALMART_SELECTORS.optionControls, dialog))
      || /choose|required|select an option|how would you like/i.test(dialog.textContent ?? "");
  }

  function successMessages() {
    return new Set(allVisible(WALMART_SELECTORS.successStatus)
      .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean));
  }

  async function waitForAddOutcome(
    itemId: string,
    exactTitle: string,
    beforeCount?: number,
    previousSuccess = new Set<string>(),
  ) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const count = cartCount();
      if (beforeCount !== undefined && count !== undefined && count > beforeCount) return "added" as const;
      const newSuccess = [...successMessages()].find((message) =>
        !previousSuccess.has(message) && /added to (?:your )?cart/i.test(message));
      if (newSuccess) return "added" as const;
      if (matchingIncrementButton(itemId, exactTitle)) return "added" as const;
      if (hasSecurityGate() || hasRequiredChoice()) return "needs_choice" as const;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return "failed" as const;
  }

  class WalmartAdapter implements RetailerPageAdapter {
    getContext() {
      const location = locationText();
      const locationDetails = parsedLocationText(location);
      const zip = pageLocationMetadata()?.postalCode
        ?? CartivaWalmartControlPolicy.postalCodeFromUsAddress(location);
      return {
        onWalmart: true,
        storeId: getStoreId(),
        storeName: locationDetails.storeName,
        address: locationDetails.address,
        zip,
        fulfillmentMode: selectedFulfillment(),
        pageType: pageType(),
      };
    }

    async getPickupStores() {
      const deadline = Date.now() + 8_000;
      let stores = pickupStoreOptions();
      while (!stores.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        stores = pickupStoreOptions();
      }
      return { stores };
    }

    async selectPickupStore(storeId: string) {
      if (!/^\d{1,8}$/.test(storeId)) {
        throw new Error("The selected Walmart store identifier is invalid.");
      }
      const option = () => pickupStoreOptions().find((store) => store.id === storeId);
      let store = option();
      const storeDeadline = Date.now() + 8_000;
      while (!store && Date.now() < storeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        store = option();
      }
      if (!store) throw new Error("That Walmart is no longer in the visible store list. Search the ZIP again.");
      const initialStore = store;
      if (store.selected) return { store, selected: true, message: `${store.name} is already your Walmart store.` };

      const link = allVisible(WALMART_SELECTORS.storeDetailLinks)
        .find((entry) => (entry.getAttribute("href") ?? "").match(/^\/store\/(\d{1,8})(?:[/?#]|$)/)?.[1] === storeId);
      const selector = link ? storeCardFor(link)?.querySelector<HTMLButtonElement>("button[role='checkbox'][aria-label]") : undefined;
      if (!selector || selector.disabled) throw new Error("Walmart did not provide a selectable control for that store.");
      selector.click();
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        store = option();
        if (store?.selected) {
          return { store, selected: true, message: `${store.name} is now your Walmart store.` };
        }
      }
      return {
        store: store ?? initialStore,
        selected: false,
        message: "Walmart did not visibly confirm the selected store.",
      };
    }

    async setFulfillment(mode: "pickup" | "delivery") {
      if (selectedFulfillment() === mode) {
        return { confirmed: true, message: `${mode === "pickup" ? "Pickup" : "Delivery"} is already selected at Walmart.` };
      }
      let dialog = firstVisible(WALMART_SELECTORS.fulfillmentDialog);
      if (!dialog) {
        const trigger = firstVisible(WALMART_SELECTORS.locationTrigger) as HTMLButtonElement | undefined;
        if (!trigger || trigger.disabled) {
          return { confirmed: false, message: "Open Walmart's location control and choose Pickup." };
        }
        trigger.click();
        const dialogDeadline = Date.now() + 5_000;
        while (Date.now() < dialogDeadline && !dialog) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          dialog = firstVisible(WALMART_SELECTORS.fulfillmentDialog);
        }
      }
      const button = dialog
        ? [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
            normalize(entry.getAttribute("aria-label") ?? entry.textContent ?? "") === mode)
        : undefined;
      if (!button || button.disabled) {
        return { confirmed: false, message: `Walmart did not show a ${mode} control. Choose it on Walmart, then refresh Cartiva.` };
      }
      button.click();
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const currentButton = firstVisible(WALMART_SELECTORS.fulfillmentDialog)
          ? [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((entry) =>
              normalize(entry.getAttribute("aria-label") ?? entry.textContent ?? "") === mode)
          : undefined;
        if (selectedFulfillment() === mode || currentButton?.getAttribute("aria-pressed") === "true") {
          return { confirmed: true, message: `${mode === "pickup" ? "Pickup" : "Delivery"} is selected at Walmart.` };
        }
      }
      return {
        confirmed: false,
        message: `The store was selected, but Walmart still needs you to choose ${mode === "pickup" ? "Pickup" : "Delivery"} visibly.`,
      };
    }

    async addProduct(itemId: string, _productId: string | undefined, exactTitle: string, quantity: number): Promise<AddResult> {
      const pageIdentifier = location.pathname.match(/^\/ip\/(?:[^/]+\/)?(\d+)\/?$/i)?.[1];
      if (!/^\d{6,20}$/.test(itemId) || !pageIdentifier || pageIdentifier !== itemId) {
        return { status: "unavailable", message: "The open Walmart page does not match the verified product ID." };
      }
      if (hasSecurityGate()) {
        return { status: "needs_choice", message: "Complete Walmart's sign-in or security check, then resume." };
      }
      const addButton = await waitForMatchingAddButton(itemId, exactTitle);
      if (!addButton || addButton.disabled) {
        return {
          status: "unavailable",
          message: "No Add button tied to this exact product was available. Recommendation buttons were ignored.",
        };
      }

      const baselineCartCount = cartCount();
      const previousSuccess = successMessages();
      addButton.click();
      const firstOutcome = await waitForAddOutcome(itemId, exactTitle, baselineCartCount, previousSuccess);
      if (firstOutcome === "needs_choice") {
        return {
          status: "needs_choice",
          message: "Walmart needs a visible option or security step completed before Cartiva can continue.",
          baselineCartCount,
        };
      }
      if (firstOutcome !== "added") {
        return { status: "failed", message: "Walmart did not visibly confirm the add before timeout.", baselineCartCount };
      }

      for (let addedQuantity = 1; addedQuantity < Math.max(1, quantity); addedQuantity += 1) {
        const increment = matchingIncrementButton(itemId, exactTitle);
        if (!increment || increment.disabled) {
          return {
            status: "needs_choice",
            message: `Added 1 of ${quantity}. Set the remaining quantity on Walmart, then resume.`,
            baselineCartCount,
          };
        }
        const previousQuantity = stepperQuantity(increment);
        increment.click();
        const confirmedQuantity = await waitForStepperQuantity(itemId, exactTitle, previousQuantity);
        if (confirmedQuantity === undefined) {
          return {
            status: "needs_choice",
            message: `Walmart confirmed ${addedQuantity} of ${quantity}. Finish the quantity, then resume.`,
            baselineCartCount,
          };
        }
      }
      return { status: "added", message: `Walmart visibly confirmed quantity ${Math.max(1, quantity)}.`, baselineCartCount };
    }

    verifyManualAdd(exactTitle: string, expectedQuantity: number, baselineCartCount?: number) {
      const current = cartCount();
      const itemId = location.pathname.match(/^\/ip\/(?:[^/]+\/)?(\d+)\/?$/i)?.[1] ?? "";
      const exactStepperQuantity = stepperQuantity(matchingIncrementButton(itemId, exactTitle));
      const pageTitle = firstVisible(WALMART_SELECTORS.productTitle)?.textContent ?? "";
      const exactProductVisible = titleMatches(exactTitle, pageTitle)
        || Boolean(matchingIncrementButton(itemId, exactTitle));
      const cartIncreased = baselineCartCount !== undefined && current !== undefined && current > baselineCartCount;
      const added = baselineCartCount !== undefined && exactProductVisible && cartIncreased && (
        exactStepperQuantity !== undefined
          ? exactStepperQuantity >= expectedQuantity
          : expectedQuantity === 1
      );
      return {
        added,
        message: added
          ? "Walmart's visible cart state confirms the manual choice and quantity."
          : baselineCartCount === undefined
            ? "Cartiva had no saved pre-click evidence after restarting, so it skipped this item rather than risk a duplicate."
            : "No exact-product cart increase was detected; Cartiva skipped this item rather than claiming success.",
      };
    }
  }

  const adapter = new WalmartAdapter();
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const request = message as Record<string, unknown>;
    if (request.type === "CARTIVA_WALMART_GET_CONTEXT") {
      sendResponse(adapter.getContext());
      return;
    }
    if (request.type === "CARTIVA_WALMART_GET_PICKUP_STORES") {
      void adapter.getPickupStores()
        .then(sendResponse)
        .catch(() => sendResponse({ stores: [] }));
      return true;
    }
    if (request.type === "CARTIVA_WALMART_SELECT_PICKUP_STORE") {
      void adapter.selectPickupStore(typeof request.storeId === "string" ? request.storeId : "")
        .then(sendResponse)
        .catch((error: unknown) => sendResponse({
          selected: false,
          message: error instanceof Error ? error.message : "Walmart store selection failed.",
        }));
      return true;
    }
    if (request.type === "CARTIVA_WALMART_SET_FULFILLMENT") {
      const mode = request.mode === "delivery" ? "delivery" : "pickup";
      void adapter.setFulfillment(mode).then(sendResponse).catch((error: unknown) => sendResponse({
        confirmed: false,
        message: error instanceof Error ? error.message : "Walmart fulfillment selection failed.",
      }));
      return true;
    }
    if (request.type === "CARTIVA_WALMART_VERIFY_MANUAL_ADD") {
      sendResponse(adapter.verifyManualAdd(
        typeof request.productTitle === "string" ? request.productTitle : "",
        typeof request.expectedQuantity === "number" ? request.expectedQuantity : 1,
        typeof request.baselineCartCount === "number" ? request.baselineCartCount : undefined,
      ));
      return;
    }
    if (request.type === "CARTIVA_WALMART_ADD_PRODUCT") {
      void adapter.addProduct(
        typeof request.itemId === "string" ? request.itemId : "",
        typeof request.productId === "string" ? request.productId : undefined,
        typeof request.productTitle === "string" ? request.productTitle : "",
        typeof request.quantity === "number" ? request.quantity : 1,
      ).then(sendResponse).catch((error: unknown) => sendResponse({
        status: "failed",
        message: error instanceof Error ? error.message : "Walmart interaction failed.",
      }));
      return true;
    }
  });
})();
