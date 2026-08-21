import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const root = process.cwd();
const output = path.join(root, "docs", "assets");

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error("Could not reserve a local screenshot port");
  return port;
}

async function waitForReady(origin, processLogs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/ready`);
      if (response.ok) return;
    } catch {
      // The process may still be binding the local listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Production server did not become ready\n${processLogs()}`);
}

function observePage(page) {
  const issues = [];
  page.on("console", (message) => {
    if (message.type() === "error") issues.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => issues.push(`page: ${error.message}`));
  page.on("requestfailed", (request) =>
    issues.push(
      `request: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    ),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      issues.push(`response: ${response.status()} ${response.url()}`);
  });
  return issues;
}

async function waitForWorkspace(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("status", { name: "Live stream connected" }).waitFor();
  await page.getByLabel("Application runtime map").waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => true));
}

const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
let logs = "";
const server = spawn(process.execPath, ["dist-server/server/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    ATLAS_LOG_LEVEL: "error",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (chunk) => (logs += chunk.toString()));
server.stderr.on("data", (chunk) => (logs += chunk.toString()));

let browser;
try {
  await waitForReady(origin, () => logs.slice(-8_000));
  await mkdir(output, { recursive: true });
  const reset = await fetch(`${origin}/api/traces`, { method: "DELETE" });
  if (!reset.ok) throw new Error(`Trace reset failed with ${reset.status}`);

  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? "chrome",
    headless: true,
  });
  const desktop = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1600, height: 1000 },
    colorScheme: "dark",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
  });
  const page = await desktop.newPage();
  const desktopIssues = observePage(page);
  await waitForWorkspace(page);

  await page.screenshot({
    path: path.join(output, "runtime-atlas-overview.png"),
    animations: "disabled",
  });

  const checkout = page.getByRole("button", {
    name: "POST /checkout",
    exact: true,
  });
  await checkout.click();
  await checkout.waitFor({ state: "visible" });
  await page
    .locator(".trace-row")
    .filter({ hasText: "/checkout" })
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: /Orders DB, database, complete/ })
    .waitFor();

  await page.screenshot({
    path: path.join(output, "runtime-atlas-checkout.png"),
    animations: "disabled",
  });

  await page
    .getByRole("button", { name: /Orders DB, database, complete/ })
    .click();
  await page.locator('[aria-label^="Source around line"]').waitFor();
  await page.screenshot({
    path: path.join(output, "runtime-atlas-inspector.png"),
    animations: "disabled",
  });

  const mobile = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobile.newPage();
  const mobileIssues = observePage(mobilePage);
  await waitForWorkspace(mobilePage);
  await mobilePage.locator(".map-shell").scrollIntoViewIfNeeded();
  const overflow = await mobilePage.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  if (overflow > 1) throw new Error(`Mobile page overflows by ${overflow}px`);
  await mobilePage.screenshot({
    path: path.join(output, "runtime-atlas-mobile.png"),
    animations: "disabled",
  });

  const issues = [...desktopIssues, ...mobileIssues];
  if (issues.length)
    throw new Error(`Browser validation failed:\n${issues.join("\n")}`);
  await mobile.close();
  await desktop.close();

  process.stdout.write(
    `Captured 4 browser-validated screenshots in ${path.relative(root, output)}.\n`,
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}
