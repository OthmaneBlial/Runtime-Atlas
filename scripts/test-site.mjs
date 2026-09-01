import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const siteRoot = path.join(root, "site");
const screenshots = path.join(root, "test-results", "showcase");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

async function availablePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error("Could not reserve a showcase test port");
  return port;
}

function serveStatic() {
  return createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      );
      const requested = pathname === "/" ? "/index.html" : pathname;
      const absolute = path.resolve(siteRoot, `.${requested}`);
      if (!absolute.startsWith(`${siteRoot}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const metadata = await stat(absolute);
      if (!metadata.isFile()) throw new Error("Not a file");
      const content = await readFile(absolute);
      response.writeHead(200, {
        "content-type":
          contentTypes.get(path.extname(absolute)) ??
          "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(content);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
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

async function assertNoOverflow(page, label) {
  const result = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    return {
      overflow: document.documentElement.scrollWidth - viewport,
      offenders: [...document.querySelectorAll("body *")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${
              element.classList.length
                ? `.${[...element.classList].join(".")}`
                : ""
            }`,
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
          };
        })
        .filter(({ left, right }) => left < -1 || right > viewport + 1)
        .sort((a, b) => b.right - a.right)
        .slice(0, 8),
    };
  });
  if (result.overflow > 1)
    throw new Error(
      `${label} overflows by ${result.overflow}px: ${JSON.stringify(result.offenders)}`,
    );
}

const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const server = serveStatic();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});

let browser;
try {
  await mkdir(screenshots, { recursive: true });
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? "chrome",
    headless: true,
  });

  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const desktopPage = await desktop.newPage();
  const desktopIssues = observePage(desktopPage);
  await desktopPage.goto(origin, { waitUntil: "networkidle" });
  await expect(desktopPage).toHaveTitle(
    "Node.js Request Map & Trace Replay | Runtime Atlas",
  );
  await expect(
    desktopPage.getByRole("heading", { name: "See where it went." }),
  ).toBeVisible();
  await expect(
    desktopPage.getByRole("heading", {
      name: "One request. Three useful views.",
    }),
  ).toBeVisible();

  const sourceTab = desktopPage.getByRole("tab", {
    name: /Open the source/,
  });
  await sourceTab.click();
  await expect(sourceTab).toHaveAttribute("aria-selected", "true");
  await expect(desktopPage.locator("[data-tour-image]")).toHaveAttribute(
    "src",
    "assets/runtime-atlas-inspector.png",
  );

  const failureTab = desktopPage.getByRole("tab", {
    name: /Stop on failure/,
  });
  await failureTab.press("ArrowLeft");
  await expect(sourceTab).toBeFocused();
  await failureTab.click();
  await expect(desktopPage.locator("[data-tour-image]")).toHaveAttribute(
    "src",
    "assets/runtime-atlas-failure.png",
  );
  await expect(
    desktopPage.getByText("Stop where the dependency failed."),
  ).toBeVisible();

  await desktopPage.locator("[data-tour-media]").click();
  await expect(desktopPage.locator("#image-viewer")).toBeVisible();
  await desktopPage.getByRole("button", { name: "Close image viewer" }).click();
  await expect(desktopPage.locator("#image-viewer")).not.toBeVisible();
  await expect(desktopPage.locator("[data-tour-media]")).toBeFocused();
  const skipLinkState = await desktopPage
    .locator(".skip-link")
    .evaluate((link) => ({
      focused: document.activeElement === link,
      clipPath: getComputedStyle(link).clipPath,
    }));
  if (!skipLinkState.focused && skipLinkState.clipPath === "none")
    throw new Error(
      `unfocused skip link is not visually clipped: ${JSON.stringify(skipLinkState)}`,
    );

  const desktopA11y = await new AxeBuilder({ page: desktopPage }).analyze();
  expect(desktopA11y.violations).toEqual([]);
  await assertNoOverflow(desktopPage, "desktop showcase");
  const productImages = desktopPage.locator(".tour-card img");
  for (let index = 0; index < (await productImages.count()); index += 1) {
    const productImage = productImages.nth(index);
    await productImage.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        productImage.evaluate(
          (image) => image.complete && image.naturalWidth > 0,
        ),
      )
      .toBe(true);
  }
  await desktopPage.screenshot({
    path: path.join(screenshots, "desktop.png"),
    fullPage: true,
    animations: "disabled",
  });

  const docsPage = await desktop.newPage();
  const docsIssues = observePage(docsPage);
  await docsPage.goto(`${origin}/docs.html`, { waitUntil: "networkidle" });
  await docsPage
    .getByRole("searchbox", { name: "Find in docs" })
    .fill("OpenTelemetry");
  await expect(docsPage.getByText(/sections? matching/)).toBeVisible();
  await expect(
    docsPage.getByRole("heading", { name: /Connect OpenTelemetry/ }),
  ).toBeVisible();
  await assertNoOverflow(docsPage, "desktop documentation");

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    reducedMotion: "reduce",
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobile.newPage();
  const mobileIssues = observePage(mobilePage);
  await mobilePage.goto(origin, { waitUntil: "networkidle" });
  await mobilePage.getByRole("tab", { name: /Stop on failure/ }).click();
  await expect(mobilePage.locator("[data-tour-image]")).toHaveAttribute(
    "src",
    "assets/runtime-atlas-failure.png",
  );
  await assertNoOverflow(mobilePage, "mobile showcase");
  const mobileA11y = await new AxeBuilder({ page: mobilePage }).analyze();
  expect(mobileA11y.violations).toEqual([]);
  await mobilePage.screenshot({
    path: path.join(screenshots, "mobile.png"),
    fullPage: true,
    animations: "disabled",
  });

  const issues = [...desktopIssues, ...docsIssues, ...mobileIssues];
  if (issues.length)
    throw new Error(`Showcase browser issues:\n${issues.join("\n")}`);

  await mobile.close();
  await desktop.close();
  process.stdout.write(
    `Showcase browser QA passed at desktop and mobile viewports; captures written to ${path.relative(root, screenshots)}.\n`,
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
