import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const targetUrl = process.argv[2] ?? "http://127.0.0.1:3000/compare";
const chromePath = process.env.CARTIVA_CHROME_PATH
  ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = 9237;
const profile = path.join(tmpdir(), `cartiva-responsive-qa-${process.pid}`);
mkdirSync(profile, { recursive: true });

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
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
      expression: "JSON.stringify({innerWidth:window.innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyScrollWidth:document.body.scrollWidth,readyState:document.readyState})",
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
    const overflow = Math.max(metrics.scrollWidth, metrics.bodyScrollWidth) - metrics.innerWidth;
    results.push({ ...viewport, ...metrics, overflow, screenshotPath });
    if (overflow > 0) throw new Error(`${viewport.name} has ${overflow}px horizontal overflow.`);
  }

  console.log(JSON.stringify(results, null, 2));
} finally {
  client?.close();
  chrome.kill();
}
