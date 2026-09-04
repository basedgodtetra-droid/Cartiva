import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const targetUrl = process.argv[2] ?? "http://localhost:3000/compare";
const chromePath = process.env.CARTIVA_CHROME_PATH
  ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = 9237;
const profile = path.join(tmpdir(), `cartiva-responsive-qa-${process.pid}`);
mkdirSync(profile, { recursive: true });

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore", windowsHide: true });

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function debugTarget() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Chrome may still be opening its debugging socket.
    }
    await delay(100);
  }
  throw new Error("Chrome did not expose a responsive-QA page.");
}

function protocol(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

const viewports = [
  { name: "mobile-390", width: 390, height: 844, mobile: true },
  { name: "tablet-768", width: 768, height: 1024, mobile: true },
  { name: "desktop-1440", width: 1440, height: 1000, mobile: false },
];

const longListCounts = [10, 20, 50];

let client;
try {
  const target = await debugTarget();
  client = protocol(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send("Page.enable");

  const results = [];
  for (const viewport of viewports) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
    await client.send("Page.navigate", { url: targetUrl });
    await delay(1_200);
    const evaluation = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify((() => {
        const groceryRegion = document.querySelector('[aria-label="Your grocery list"]');
        const basketRegion = document.querySelector('[aria-label="Kroger matched basket"]');
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          readyState: document.readyState,
          groceryOverflowY: groceryRegion ? getComputedStyle(groceryRegion).overflowY : null,
          basketOverflowY: basketRegion ? getComputedStyle(basketRegion).overflowY : null,
        };
      })())`,
      returnByValue: true,
    });
    const metrics = JSON.parse(evaluation.result.value);
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const screenshotPath = path.join(tmpdir(), `cartiva-${viewport.name}.png`);
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    const overflow = Math.max(0, Math.max(metrics.scrollWidth, metrics.bodyScrollWidth) - metrics.innerWidth);
    results.push({ ...viewport, ...metrics, overflow, screenshotPath });
    if (overflow > 0) throw new Error(`${viewport.name} has ${overflow}px horizontal overflow.`);
    if (viewport.width <= 640 && (metrics.groceryOverflowY !== "visible" || metrics.basketOverflowY !== "visible")) {
      throw new Error(`${viewport.name} has a competing nested scroll region.`);
    }
    if (viewport.width > 640 && (metrics.groceryOverflowY !== "auto" || metrics.basketOverflowY !== "auto")) {
      throw new Error(`${viewport.name} does not expose both contained item scrollers.`);
    }
  }

  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 1440,
    screenHeight: 1000,
  });
  await client.send("Page.navigate", { url: targetUrl });
  await delay(800);

  const longLists = [];
  for (const itemCount of longListCounts) {
    const workspace = {
      rawInput: Array.from({ length: itemCount }, (_, index) => `grocery item ${index + 1}`).join("\n"),
      zipCode: "75201",
      quantities: {},
      fulfillmentMode: "pickup",
      listName: `${itemCount}-item layout test`,
      proteinOrigins: {},
      creationMode: "grocery-list",
      activePlanIngredients: [],
    };
    const storageWrite = await client.send("Runtime.evaluate", {
      expression: `localStorage.setItem("cartiva-web-workspace-v1", ${JSON.stringify(JSON.stringify(workspace))});`,
      returnByValue: true,
    });
    if (storageWrite.exceptionDetails) {
      throw new Error(`Could not prepare the ${itemCount}-item layout fixture.`);
    }
    const fixtureUrl = `${targetUrl}${targetUrl.includes("?") ? "&" : "?"}layout-qa=${itemCount}`;
    await client.send("Page.navigate", { url: fixtureUrl });
    await delay(3_000);
    const evaluation = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify((() => {
        const groceryRegion = document.querySelector('[aria-label="Your grocery list"]');
        const basketRegion = document.querySelector('[aria-label="Kroger matched basket"]');
        const listPanel = groceryRegion?.closest('section');
        const comparisonPanel = document.querySelector('#compare');
        const comparisonHeading = comparisonPanel?.querySelector('h2')?.parentElement;
        const retailerGrid = comparisonPanel?.querySelector('[aria-label="Retailer totals"]');
        const evidenceBar = retailerGrid?.nextElementSibling;
        const basketCard = basketRegion?.closest('article');
        const basketHeader = basketRegion?.previousElementSibling;
        const subtotalPanel = basketRegion?.nextElementSibling;
        const storeControls = document.querySelector('[aria-label="Fulfillment method"]')?.closest('div')?.parentElement;
        const compareButton = [...document.querySelectorAll('button')].find((button) => /Compare basket|Compare again/.test(button.textContent ?? ''));
        const subtotal = [...document.querySelectorAll('*')].find((element) => element.textContent?.trim() === 'Product subtotal')?.parentElement;
        const handoff = [...document.querySelectorAll('button, a')].find((element) => /Add basket to Kroger|Connect Kroger|Open Kroger cart/.test(element.textContent ?? ''));
        const rect = (element) => element ? element.getBoundingClientRect() : null;
        return {
          currentUrl: location.href,
          storedItemCount: (() => {
            try {
              return JSON.parse(localStorage.getItem('cartiva-web-workspace-v1') ?? '{}').rawInput?.split('\\n').length ?? 0;
            } catch {
              return -1;
            }
          })(),
          renderedGroceries: groceryRegion?.querySelectorAll('[id^="list-item-"]').length ?? 0,
          renderedBasketRows: basketRegion?.children.length ?? 0,
          pageScrollHeight: document.documentElement.scrollHeight,
          listPanel: rect(listPanel),
          comparisonPanel: rect(comparisonPanel),
          comparisonHeading: rect(comparisonHeading),
          retailerGrid: rect(retailerGrid),
          evidenceBar: rect(evidenceBar),
          basketCard: rect(basketCard),
          basketHeader: rect(basketHeader),
          subtotalPanel: rect(subtotalPanel),
          groceryClientHeight: groceryRegion?.clientHeight ?? 0,
          groceryScrollHeight: groceryRegion?.scrollHeight ?? 0,
          basketClientHeight: basketRegion?.clientHeight ?? 0,
          basketScrollHeight: basketRegion?.scrollHeight ?? 0,
          storeControls: rect(storeControls),
          compareButton: rect(compareButton),
          subtotal: rect(subtotal),
          handoff: rect(handoff),
        };
      })())`,
      returnByValue: true,
    });
    const metrics = JSON.parse(evaluation.result.value);
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const screenshotPath = path.join(tmpdir(), `cartiva-long-list-${itemCount}.png`);
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    const topDelta = Math.abs((metrics.listPanel?.top ?? 0) - (metrics.comparisonPanel?.top ?? 0));
    const heightDelta = Math.abs((metrics.listPanel?.height ?? 0) - (metrics.comparisonPanel?.height ?? 0));
    const groceryScrolls = metrics.groceryScrollHeight > metrics.groceryClientHeight;
    const basketScrolls = metrics.basketScrollHeight > metrics.basketClientHeight;
    const fixedActionsVisible = [metrics.storeControls, metrics.compareButton, metrics.subtotal, metrics.handoff]
      .every((bounds) => bounds && bounds.top >= 0 && bounds.bottom <= 1000);
    const result = {
      itemCount,
      ...metrics,
      topDelta,
      heightDelta,
      groceryScrolls,
      basketScrolls,
      fixedActionsVisible,
      screenshotPath,
    };
    longLists.push(result);
    if (metrics.renderedGroceries !== itemCount || metrics.renderedBasketRows !== itemCount) {
      throw new Error(`${itemCount}-item layout stored ${metrics.storedItemCount}, rendered ${metrics.renderedGroceries} groceries and ${metrics.renderedBasketRows} basket rows at ${metrics.currentUrl}.`);
    }
    if (topDelta > 1 || heightDelta > 1) {
      throw new Error(`${itemCount}-item panels are not aligned.`);
    }
    if (!groceryScrolls || !basketScrolls || !fixedActionsVisible) {
      throw new Error(`${itemCount}-item layout did not keep both scrollers and fixed actions usable.`);
    }
  }

  const pageHeightRange = Math.max(...longLists.map((entry) => entry.pageScrollHeight))
    - Math.min(...longLists.map((entry) => entry.pageScrollHeight));
  if (pageHeightRange > 2) {
    throw new Error(`Long-list page height changed by ${pageHeightRange}px.`);
  }

  console.log(JSON.stringify({ responsive: results, longLists, pageHeightRange }, null, 2));
} finally {
  client?.close();
  chrome.kill();
}
