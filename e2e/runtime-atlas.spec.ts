import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

function observeBrowser(page: Page): string[] {
  const issues: string[] = [];

  page.on("console", (message) => {
    const expectedFailureNoise =
      message.type() === "error" &&
      /Failed to load resource:.*503 \(Service Unavailable\)/.test(
        message.text(),
      );
    if (message.type() === "error" && !expectedFailureNoise) {
      issues.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => issues.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => {
    issues.push(
      `request: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    );
  });
  page.on("response", (response) => {
    const expectedDemoFailure =
      response.status() === 503 && response.url().endsWith("/api/demo/failure");
    if (response.status() >= 400 && !expectedDemoFailure) {
      issues.push(`response: ${response.status()} ${response.url()}`);
    }
  });

  return issues;
}

async function openWorkspace(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("status", { name: "Live stream connected" }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", {
      name: /14 runtime nodes and \d+ code-derived connections/,
    }),
  ).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  const response = await request.delete("/api/traces");
  expect(response.ok()).toBeTruthy();
});

test("runs, inspects, replays, exports, fails safely, and clears a trace", async ({
  page,
}) => {
  const browserIssues = observeBrowser(page);
  await openWorkspace(page);

  const checkout = page.getByRole("button", {
    name: "POST /checkout",
    exact: true,
  });
  await checkout.click();
  await expect(checkout).toBeEnabled();

  const checkoutTrace = page
    .locator(".trace-row")
    .filter({ hasText: "/checkout" })
    .first();
  await expect(checkoutTrace).toContainText("200");

  await page
    .getByRole("button", { name: /Orders DB, database, complete/ })
    .click();
  await expect(page.getByLabel("Orders DB inspector")).toBeVisible();
  await expect(
    page.locator('[aria-label^="Source around line"]'),
  ).toBeVisible();

  await page.getByRole("button", { name: /Find a node/ }).click();
  const search = page.getByRole("dialog", { name: "Find a runtime node" });
  await search
    .getByRole("textbox", { name: "Search runtime nodes" })
    .fill("pricing");
  await search
    .locator(".search-results button")
    .filter({ hasText: "Pricing service" })
    .click();
  await expect(page.getByLabel("Pricing service inspector")).toBeVisible();

  const playback = page.getByRole("slider", {
    name: "Trace playback position",
  });
  await playback.fill("1");
  await expect(playback).toHaveValue("1");
  await page.getByRole("button", { name: "Replay trace" }).click();

  const failure = page.getByRole("button", {
    name: "FAIL /payment",
    exact: true,
  });
  await failure.click();
  await expect(failure).toBeEnabled();
  await expect(
    page.locator(".trace-row").filter({ hasText: "503" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Payment API, external, error/ }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  const exported = await page.request.get("/api/traces/export");
  expect(exported.status()).toBe(200);
  expect(exported.headers()["content-type"]).toContain("application/json");
  expect((await exported.json()).traces).toHaveLength(2);

  await page.getByRole("button", { name: "Clear trace history" }).click();
  await expect(page.getByText("No requests captured yet.")).toBeVisible();
  expect(browserIssues).toEqual([]);
});

test("has no automatically detectable accessibility violations", async ({
  page,
}) => {
  const browserIssues = observeBrowser(page);
  await openWorkspace(page);
  await page
    .getByRole("button", { name: "POST /checkout", exact: true })
    .click();
  await expect(
    page.locator(".trace-row").filter({ hasText: "/checkout" }).first(),
  ).toContainText("200");

  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations).toEqual([]);
  expect(browserIssues).toEqual([]);
});

test("keeps the live workflow usable without horizontal overflow", async ({
  page,
}) => {
  const browserIssues = observeBrowser(page);
  await openWorkspace(page);

  await page
    .getByRole("button", { name: "POST /checkout", exact: true })
    .click();
  const trace = page
    .locator(".trace-row")
    .filter({ hasText: "/checkout" })
    .first();
  await expect(trace).toContainText("200");
  await trace.scrollIntoViewIfNeeded();
  await expect(trace).toBeVisible();

  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  expect(browserIssues).toEqual([]);
});
