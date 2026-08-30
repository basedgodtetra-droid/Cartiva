(() => {
  type TargetFulfillmentMode = "pickup" | "delivery" | "shipping";
  type AddResult = {
    status: "added" | "needs_choice" | "unavailable" | "failed";
    message: string;
    baselineCartCount?: number;
  };

  // Target changes markup regularly. Keep every visible-control selector here.
  const TARGET_SELECTORS = {
    productTitle: ["h1[data-test='product-title']", "main h1"],
    productRoot: [
      "main [data-test='product-detail-page']",
      "main [data-test='product-detail']",
      "main",
    ],
    addButtons: [
      "button[data-test='orderPickupButton']",
      "button[data-test='sameDayDeliveryATCButton']",
      "button[data-test='scheduledDeliveryButton']",
      "button[data-test='shippingATCButton']",
      "button[data-test='shipItButton']",
      "button[data-test='addToCartButton']",
      "button[aria-label*='Add to cart' i]",
      "button[aria-label*='Ship it' i]",
      "button[aria-label*='Pick it up' i]",
    ],
    fulfillmentCells: [
      "button[data-test='fulfillment-cell-pickup']",
      "button[data-test='fulfillment-cell-delivery']",
      "button[data-test='fulfillment-cell-shipping']",
    ],
    storeName: ["button[id^='store-name-']", "[id^='store-name-']"],
    quantityIncrease: [
      "button[data-test='cartItemQuantityIncrement']",
      "button[data-test*='quantity' i][aria-label*='increase' i]",
      "button[aria-label*='increase quantity' i]",
    ],
    quantityButton: ["button[aria-expanded][id]"],
    cartLink: [
      "a[data-test='@web/CartLink']",
      "a[data-test='cart-link']",
      "a[href='/cart']",
      "a[href^='/cart?']",
    ],
    successStatus: ["[role='status']", "[aria-live='polite']", "[data-test*='toast' i]"],
    dialog: ["[role='dialog']"],
    loginGate: [
      "[role='dialog'] input[type='password']",
      "form[action*='login' i] input[type='password']",
      "form[action*='signin' i] input[type='password']",
    ],
    captchaGate: ["iframe[src*='captcha' i]", "[data-test*='captcha' i]", "[id*='captcha' i]"],
    recommendationRegion: [
      "[data-test*='recommend' i]",
      "[data-test*='carousel' i]",
      "[data-test*='similar' i]",
      "[data-test*='related' i]",
      "section[aria-label*='recommend' i]",
      "section[aria-label*='similar' i]",
      "section[aria-label*='frequently' i]",
    ],
  } as const;

  const visible = (element: HTMLElement) => Boolean(element.getClientRects().length)
    && getComputedStyle(element).visibility !== "hidden";

  function firstVisible(selectors: readonly string[], root: ParentNode = document) {
    for (const selector of selectors) {
      for (const element of root.querySelectorAll<HTMLElement>(selector)) {
        if (visible(element)) return element;
      }
    }
    return undefined;
  }

  function allVisible(selectors: readonly string[], root: ParentNode = document) {
    return selectors.flatMap((selector) => [...root.querySelectorAll<HTMLElement>(selector)])
      .filter((element, index, values) => values.indexOf(element) === index)
      .filter(visible);
  }

  const normalize = (value: string) => value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  function titleMatches(expected: string, actual: string) {
    const expectedTitle = normalize(expected);
    const actualTitle = normalize(actual);
    return expectedTitle.length >= 4
      && actualTitle.length >= 4
      && (actualTitle.includes(expectedTitle) || expectedTitle.includes(actualTitle));
  }

  function pageTcin() {
    return location.pathname.match(/\/-\/A-(\d{6,12})(?:\/|$)/i)?.[1];
  }

  function pageTitle() {
    return firstVisible(TARGET_SELECTORS.productTitle)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }

  function cartCount() {
    const cart = firstVisible(TARGET_SELECTORS.cartLink);
    const text = `${cart?.getAttribute("aria-label") ?? ""} ${cart?.textContent ?? ""}`;
    const match = text.match(/(?:cart\D*)?(\d+)\s*(?:items?)?/i);
    return match ? Number(match[1]) : undefined;
  }

  function isInsideRecommendation(element: Element) {
    return TARGET_SELECTORS.recommendationRegion.some((selector) => Boolean(element.closest(selector)));
  }

  function buttonModes(button: HTMLElement): TargetFulfillmentMode[] {
    const directMarker = normalize([
      button.getAttribute("data-test") ?? "",
      button.getAttribute("aria-label") ?? "",
      button.textContent ?? "",
    ].join(" "));
    const readModes = (marker: string) => {
      const modes: TargetFulfillmentMode[] = [];
      if (/pickup|pick it up|drive up/.test(marker)) modes.push("pickup");
      if (/same day|scheduled delivery|delivery|deliver it/.test(marker)) modes.push("delivery");
      if (/shipping|ship it|ship to/.test(marker)) modes.push("shipping");
      return modes;
    };
    const directModes = readModes(directMarker);
    if (directModes.length) return directModes;
    const marker = normalize(button.parentElement?.textContent ?? "");
    const modes: TargetFulfillmentMode[] = [];
    if (/pickup|pick it up|drive up/.test(marker)) modes.push("pickup");
    if (/same day|scheduled delivery|delivery|deliver it/.test(marker)) modes.push("delivery");
    if (/shipping|ship it|ship to/.test(marker)) modes.push("shipping");
    return modes;
  }

  function primaryRoot() {
    return TARGET_SELECTORS.productRoot
      .map((selector) => firstVisible([selector]))
      .find(Boolean) ?? document;
  }

  function fulfillmentCell(mode: TargetFulfillmentMode) {
    return firstVisible([`button[data-test='fulfillment-cell-${mode}']`]) as HTMLButtonElement | undefined;
  }

  function selectedFulfillmentCell(mode: TargetFulfillmentMode) {
    const cell = fulfillmentCell(mode);
    return Boolean(cell && CartivaTargetControlPolicy.fulfillmentCellIsSelected({
      ariaLabel: cell.getAttribute("aria-label"),
      ariaSelected: cell.getAttribute("aria-selected"),
      ariaPressed: cell.getAttribute("aria-pressed"),
      dataSelected: cell.getAttribute("data-selected"),
    }));
  }

  async function selectFulfillment(mode: TargetFulfillmentMode) {
    let cell = fulfillmentCell(mode);
    const cellDeadline = Date.now() + 5_000;
    while (!cell && Date.now() < cellDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      cell = fulfillmentCell(mode);
    }
    if (!cell || cell.disabled || cell.getAttribute("aria-disabled") === "true") return false;
    if (!selectedFulfillmentCell(mode)) cell.click();
    const selectedDeadline = Date.now() + 5_000;
    while (Date.now() < selectedDeadline) {
      if (selectedFulfillmentCell(mode)) return true;
      if (hasSecurityGate() || hasRequiredChoice()) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  function matchingControl(
    kind: CartivaTargetControlKind,
    tcin: string,
    exactTitle: string,
    fulfillmentMode: TargetFulfillmentMode,
  ) {
    const root = primaryRoot();
    const selectors = kind === "add" ? TARGET_SELECTORS.addButtons : TARGET_SELECTORS.quantityIncrease;
    const buttons = allVisible(selectors, root) as HTMLButtonElement[];
    const candidates = buttons.map((button): CartivaTargetControlCandidate => ({
      label: button.getAttribute("aria-label") ?? button.textContent ?? "",
      disabled: button.disabled,
      ariaDisabled: button.getAttribute("aria-disabled") === "true",
      inRecommendation: isInsideRecommendation(button),
      inPrimaryRoot: button.closest("main") !== null,
      explicitControlSelector: Boolean(button.getAttribute("data-test")),
      fulfillmentModes: buttonModes(button),
    }));
    const index = CartivaTargetControlPolicy.chooseCandidate({
      kind,
      tcin,
      exactTitle,
      pageTitleMatches: pageTcin() === tcin && titleMatches(exactTitle, pageTitle()),
      fulfillmentMode,
      candidates,
    });
    return index === undefined ? undefined : buttons[index];
  }

  function hasSecurityGate() {
    return Boolean(firstVisible(TARGET_SELECTORS.loginGate) || firstVisible(TARGET_SELECTORS.captchaGate));
  }

  function hasRequiredChoice() {
    const dialog = firstVisible(TARGET_SELECTORS.dialog);
    if (!dialog) return false;
    const text = normalize(dialog.textContent ?? "");
    return /choose|select|sign in|required|location|store|fulfillment/.test(text);
  }

  function successMessages() {
    return new Set(allVisible(TARGET_SELECTORS.successStatus)
      .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean));
  }

  async function waitForAddButton(
    tcin: string,
    exactTitle: string,
    fulfillmentMode: TargetFulfillmentMode,
  ) {
    const deadline = Date.now() + 7_000;
    while (Date.now() < deadline) {
      const button = matchingControl("add", tcin, exactTitle, fulfillmentMode);
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
      if (hasSecurityGate()) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  }

  async function waitForAddOutcome(
    tcin: string,
    exactTitle: string,
    fulfillmentMode: TargetFulfillmentMode,
    beforeCount: number | undefined,
    previousSuccess: Set<string>,
    expectedQuantity: number,
  ) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const count = cartCount();
      if (beforeCount !== undefined && count !== undefined && count >= beforeCount + expectedQuantity) return "added" as const;
      const success = [...successMessages()].find((message) =>
        !previousSuccess.has(message) && /added to (?:your )?(?:cart|basket)/i.test(message));
      if (success && (beforeCount === undefined || expectedQuantity === 1)) return "added" as const;
      if (expectedQuantity === 1 && matchingControl("increment", tcin, exactTitle, fulfillmentMode)) return "added" as const;
      if (hasSecurityGate() || hasRequiredChoice()) return "needs_choice" as const;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return "failed" as const;
  }

  function selectedQuantityButton() {
    return allVisible(TARGET_SELECTORS.quantityButton, primaryRoot())
      .find((element) => /^qty\s+\d+$/i.test((element.textContent ?? "").replace(/\s+/g, " ").trim())) as HTMLButtonElement | undefined;
  }

  async function chooseQuantity(quantity: number) {
    if (quantity === 1) return true;
    if (quantity < 1 || quantity > 10) return false;
    const button = selectedQuantityButton();
    if (!button?.id || button.disabled) return false;
    button.click();
    const menuDeadline = Date.now() + 3_000;
    let option: HTMLAnchorElement | undefined;
    while (Date.now() < menuDeadline && !option) {
      const menus = [...document.querySelectorAll<HTMLUListElement>("ul")].filter(visible);
      const menu = menus.find((entry) => [...entry.querySelectorAll<HTMLAnchorElement>("a")]
        .some((anchor) => anchor.getAttribute("href") === `#${button.id}`));
      option = menu
        ? [...menu.querySelectorAll<HTMLAnchorElement>("a[href='#'][aria-label]")]
          .find((anchor) => anchor.getAttribute("aria-label") === String(quantity) && visible(anchor))
        : undefined;
      if (!option) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!option) return false;
    option.click();
    const selectedDeadline = Date.now() + 3_000;
    while (Date.now() < selectedDeadline) {
      const selected = selectedQuantityButton();
      if (selected && normalize(selected.textContent ?? "") === `qty ${quantity}`) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async function addProduct(
    tcin: string,
    exactTitle: string,
    quantity: number,
    fulfillmentMode: TargetFulfillmentMode,
    storeId?: string,
  ): Promise<AddResult> {
    if (!/^\d{6,12}$/.test(tcin) || pageTcin() !== tcin || !titleMatches(exactTitle, pageTitle())) {
      return { status: "unavailable", message: "The open Target page does not match the verified product TCIN and title." };
    }
    if (hasSecurityGate()) {
      return { status: "needs_choice", message: "Complete Target's visible sign-in or security check, then continue." };
    }
    if (!await selectFulfillment(fulfillmentMode)) {
      return {
        status: hasSecurityGate() || hasRequiredChoice() ? "needs_choice" : "unavailable",
        message: hasSecurityGate() || hasRequiredChoice()
          ? `Target needs a visible ${fulfillmentMode} choice, store, or sign-in before Cartiva can continue.`
          : `Target did not visibly select ${fulfillmentMode} for this exact product.`,
      };
    }
    const baselineCartCount = cartCount();
    if (fulfillmentMode === "pickup") {
      const storeElementId = firstVisible(TARGET_SELECTORS.storeName)?.id;
      if (!CartivaTargetControlPolicy.visiblePickupStoreMatches(storeId, storeElementId)) {
        return {
          status: "needs_choice",
          message: `Choose Target pickup store ${storeId ?? "shown in Cartiva"} visibly, then continue.`,
          baselineCartCount,
        };
      }
    }
    if (!await chooseQuantity(Math.max(1, quantity))) {
      return {
        status: "needs_choice",
        message: quantity > 10
          ? `Target's visible quantity menu supports up to 10. Set quantity ${quantity} and add the item, then continue.`
          : `Set quantity ${quantity} visibly at Target, add the item, then continue.`,
        baselineCartCount,
      };
    }
    const addButton = await waitForAddButton(tcin, exactTitle, fulfillmentMode);
    if (!addButton) {
      return {
        status: hasSecurityGate() ? "needs_choice" : "unavailable",
        message: hasSecurityGate()
          ? "Complete Target's visible sign-in or security check, then continue."
          : `Target did not show an enabled ${fulfillmentMode} Add control for this exact product.`,
      };
    }

    const previousSuccess = successMessages();
    addButton.click();
    const firstOutcome = await waitForAddOutcome(
      tcin,
      exactTitle,
      fulfillmentMode,
      baselineCartCount,
      previousSuccess,
      Math.max(1, quantity),
    );
    if (firstOutcome === "needs_choice") {
      return {
        status: "needs_choice",
        message: "Target needs a visible store, fulfillment, sign-in, or product choice before Cartiva can continue.",
        baselineCartCount,
      };
    }
    if (firstOutcome !== "added") {
      return { status: "failed", message: "Target did not visibly confirm the cart addition.", baselineCartCount };
    }

    return {
      status: "added",
      message: `Target visibly confirmed quantity ${Math.max(1, quantity)}.`,
      baselineCartCount,
    };
  }

  function verifyManualAdd(exactTitle: string, expectedQuantity: number, baselineCartCount?: number) {
    const current = cartCount();
    const exactProductVisible = /^\d{6,12}$/.test(pageTcin() ?? "") && titleMatches(exactTitle, pageTitle());
    const added = baselineCartCount !== undefined
      && current !== undefined
      && exactProductVisible
      && current >= baselineCartCount + Math.max(1, expectedQuantity);
    return {
      added,
      message: added
          ? `Target's visible cart count confirms an addition for this exact product. Review quantity ${Math.max(1, expectedQuantity)} in Target's cart.`
        : baselineCartCount === undefined
          ? "Cartiva had no saved pre-click evidence, so it skipped this item rather than risk a duplicate."
          : "Target did not visibly confirm the expected cart increase; Cartiva skipped the item.",
    };
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const request = message as Record<string, unknown>;
    if (request.type === "CARTIVA_TARGET_ADD_PRODUCT") {
      const mode = request.fulfillmentMode === "pickup" || request.fulfillmentMode === "shipping"
        ? request.fulfillmentMode
        : "delivery";
      void addProduct(
        typeof request.tcin === "string" ? request.tcin.replace(/^A-/i, "") : "",
        typeof request.productTitle === "string" ? request.productTitle : "",
        typeof request.quantity === "number" ? request.quantity : 1,
        mode,
        typeof request.storeId === "string" ? request.storeId : undefined,
      ).then(sendResponse).catch((error: unknown) => sendResponse({
        status: "failed",
        message: error instanceof Error ? error.message : "Target interaction failed.",
      }));
      return true;
    }
    if (request.type === "CARTIVA_TARGET_VERIFY_MANUAL_ADD") {
      sendResponse(verifyManualAdd(
        typeof request.productTitle === "string" ? request.productTitle : "",
        typeof request.expectedQuantity === "number" ? request.expectedQuantity : 1,
        typeof request.baselineCartCount === "number" ? request.baselineCartCount : undefined,
      ));
    }
  });
})();
