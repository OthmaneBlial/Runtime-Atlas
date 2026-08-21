import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { gzipSync } from "node:zlib";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a smoke-test port"));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const smokeStartedAt = performance.now();
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["dist-server/server/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "production",
    ATLAS_LOG_LEVEL: "silent",
    ATLAS_ALLOW_CLEAR: "true",
    ATLAS_EXPOSE_SOURCE: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

async function waitUntilReady() {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null)
      throw new Error(
        `Production server exited early with code ${child.exitCode}: ${output.slice(-1_000)}`,
      );
    try {
      const response = await fetch(`${origin}/ready`);
      if (response.ok) return response.json();
    } catch {
      // The process may still be binding its socket.
    }
    await delay(100);
  }
  throw new Error(
    `Production server did not become ready: ${output.slice(-1_000)}`,
  );
}

try {
  const ready = await waitUntilReady();
  const startupMs = Math.round(performance.now() - smokeStartedAt);
  const page = await fetch(origin);
  const html = await page.text();
  if (!page.ok || !html.includes('<div id="root"></div>'))
    throw new Error("Built SPA was not served");

  const checkoutStartedAt = performance.now();
  const checkout = await fetch(`${origin}/api/demo/checkout`, {
    method: "POST",
  });
  if (!checkout.ok)
    throw new Error(`Checkout demo returned ${checkout.status}`);
  const checkoutMs = Math.round(performance.now() - checkoutStartedAt);

  const failure = await fetch(`${origin}/api/demo/failure`, { method: "POST" });
  if (failure.status !== 503)
    throw new Error(`Failure demo returned ${failure.status} instead of 503`);

  const traces = await fetch(`${origin}/api/traces`).then((response) =>
    response.json(),
  );
  if (!Array.isArray(traces) || traces.length < 2)
    throw new Error("Production trace history did not retain both scenarios");

  const clear = await fetch(`${origin}/api/traces`, { method: "DELETE" });
  if (!clear.ok) throw new Error(`Trace cleanup returned ${clear.status}`);

  const assetNames = await readdir("dist/assets");
  const javascript = assetNames.find(
    (name) => name.startsWith("index-") && name.endsWith(".js"),
  );
  const stylesheet = assetNames.find(
    (name) => name.startsWith("index-") && name.endsWith(".css"),
  );
  if (!javascript || !stylesheet)
    throw new Error("Built UI entry assets were not found");
  const javascriptGzipBytes = gzipSync(
    await readFile(`dist/assets/${javascript}`),
  ).byteLength;
  const stylesheetGzipBytes = gzipSync(
    await readFile(`dist/assets/${stylesheet}`),
  ).byteLength;
  if (javascriptGzipBytes > 100 * 1_024)
    throw new Error(
      `UI JavaScript exceeds the 100 KiB gzip budget: ${javascriptGzipBytes} bytes`,
    );
  if (stylesheetGzipBytes > 20 * 1_024)
    throw new Error(
      `UI CSS exceeds the 20 KiB gzip budget: ${stylesheetGzipBytes} bytes`,
    );

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      port,
      startupMs,
      checkoutMs,
      topology: ready.checks?.topology,
      tracesObserved: traces.length,
      scenarios: ["checkout", "dependency-failure"],
      assetsGzipKiB: {
        javascript: Math.round((javascriptGzipBytes / 1_024) * 100) / 100,
        css: Math.round((stylesheetGzipBytes / 1_024) * 100) / 100,
      },
    })}\n`,
  );
} finally {
  if (child.exitCode == null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), delay(5_000)]);
    if (child.exitCode == null) child.kill("SIGKILL");
  }
}
