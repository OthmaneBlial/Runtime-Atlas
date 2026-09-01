import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const root = process.cwd();
const output = path.join(root, "docs", "assets");
const showcaseOutput = path.join(root, "site", "assets");
const screenshotNames = [
  "runtime-atlas-overview.png",
  "runtime-atlas-checkout.png",
  "runtime-atlas-inspector.png",
  "runtime-atlas-failure.png",
  "runtime-atlas-mobile.png",
  "runtime-atlas-social.png",
];

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
    const expectedFailureNoise =
      message.type() === "error" &&
      /Failed to load resource:.*503 \(Service Unavailable\)/.test(
        message.text(),
      );
    if (message.type() === "error" && !expectedFailureNoise)
      issues.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => issues.push(`page: ${error.message}`));
  page.on("requestfailed", (request) =>
    issues.push(
      `request: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    ),
  );
  page.on("response", (response) => {
    const expectedDemoFailure =
      response.status() === 503 && response.url().endsWith("/api/demo/failure");
    if (response.status() >= 400 && !expectedDemoFailure)
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
  await mkdir(showcaseOutput, { recursive: true });
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

  const failure = page.getByRole("button", {
    name: "FAIL /payment",
    exact: true,
  });
  await failure.click();
  await failure.waitFor({ state: "visible" });
  await page.locator(".trace-row").filter({ hasText: "503" }).first().waitFor();
  await page
    .getByRole("button", { name: /Payment API, external, error/ })
    .click();
  await page.getByLabel("Payment API inspector").waitFor();
  await page.screenshot({
    path: path.join(output, "runtime-atlas-failure.png"),
    animations: "disabled",
  });

  const [checkoutCapture, sansFont, monoFont] = await Promise.all([
    readFile(path.join(output, "runtime-atlas-checkout.png")),
    readFile(
      path.join(root, "site/assets/fonts/ibm-plex-sans-latin-variable.woff2"),
    ),
    readFile(
      path.join(root, "site/assets/fonts/ibm-plex-mono-latin-500.woff2"),
    ),
  ]);
  const social = await browser.newContext({
    viewport: { width: 1280, height: 640 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  const socialPage = await social.newPage();
  await socialPage.setContent(`<!doctype html>
    <style>
      @font-face { font-family: AtlasSans; src: url(data:font/woff2;base64,${sansFont.toString("base64")}); }
      @font-face { font-family: AtlasMono; src: url(data:font/woff2;base64,${monoFont.toString("base64")}); }
      * { box-sizing: border-box; }
      body { margin: 0; width: 1280px; height: 640px; overflow: hidden; background: #070908; color: #edf2ea; font-family: AtlasSans, sans-serif; }
      main { position: relative; display: grid; grid-template-columns: 0.92fr 1.08fr; width: 100%; height: 100%; padding: 58px 0 54px 62px; background: radial-gradient(circle at 30% 35%, rgba(199, 243, 106, .08), transparent 34%), linear-gradient(rgba(255,255,255,.016) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.016) 1px, transparent 1px); background-size: auto, 32px 32px, 32px 32px; }
      main::after { content: ''; position: absolute; inset: 0; border: 1px solid rgba(199, 243, 106, .16); pointer-events: none; }
      .copy { position: relative; z-index: 2; display: flex; flex-direction: column; }
      .brand { display: flex; align-items: center; gap: 13px; font: 600 14px AtlasMono, monospace; letter-spacing: .15em; }
      .brand em { color: #c7f36a; font-style: normal; }
      .sigil { display: grid; gap: 3px; width: 22px; transform: skew(-12deg); }
      .sigil i { display: block; height: 3px; border: 1px solid #c7f36a; }
      .eyebrow { margin-top: 80px; color: #c7f36a; font: 500 11px AtlasMono, monospace; letter-spacing: .13em; }
      h1 { margin: 17px 0 0; max-width: 560px; font-size: 54px; font-weight: 620; letter-spacing: -.052em; line-height: .94; text-transform: uppercase; }
      h1 span { color: #899187; font-weight: 370; }
      p { max-width: 485px; margin: 24px 0 0; color: #b5bcb2; font-size: 18px; line-height: 1.48; }
      .facts { display: flex; gap: 22px; margin-top: auto; color: #7d867b; font: 500 9px AtlasMono, monospace; letter-spacing: .07em; text-transform: uppercase; }
      .facts span::before { content: ''; display: inline-block; width: 5px; height: 5px; margin-right: 7px; border-radius: 50%; background: #c7f36a; box-shadow: 0 0 8px rgba(199,243,106,.6); vertical-align: 1px; }
      .product { position: relative; z-index: 1; align-self: center; height: 472px; margin: 0 0 0 34px; overflow: hidden; border: 1px solid rgba(199, 243, 106, .22); border-right: 0; background: #040605; box-shadow: -28px 38px 80px rgba(0,0,0,.48); }
      .product img { width: 755px; height: 472px; object-fit: cover; object-position: left top; }
      .product::before { content: 'POST /checkout · 26 events · source-backed'; position: absolute; z-index: 2; right: 0; bottom: 0; left: 0; padding: 15px 18px; background: linear-gradient(transparent, rgba(4,6,5,.98)); color: #c7f36a; font: 500 9px AtlasMono, monospace; letter-spacing: .08em; text-transform: uppercase; }
    </style>
    <main>
      <section class="copy">
        <div class="brand"><span class="sigil"><i></i><i></i><i></i></span><span>RUNTIME<em>ATLAS</em></span></div>
        <div class="eyebrow">LOCAL REQUEST FLIGHT RECORDER</div>
        <h1>See where it went.<br><span>See the code<br>behind it.</span></h1>
        <p>Replay one Node.js request on a live map derived from your TypeScript source.</p>
        <div class="facts"><span>Local-first</span><span>OTLP/HTTP JSON</span><span>MIT</span></div>
      </section>
      <figure class="product"><img src="data:image/png;base64,${checkoutCapture.toString("base64")}" alt=""></figure>
    </main>`);
  await socialPage.evaluate(() => document.fonts.ready);
  await socialPage.screenshot({
    path: path.join(output, "runtime-atlas-social.png"),
  });
  await social.close();

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

  await Promise.all(
    screenshotNames.map((name) =>
      copyFile(path.join(output, name), path.join(showcaseOutput, name)),
    ),
  );
  await mobile.close();
  await desktop.close();

  process.stdout.write(
    `Captured and synced ${screenshotNames.length} browser-validated screenshots.\n`,
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}
