import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const packageRoot = process.env.OFFLINE_PACKAGE_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
const { generateOfflineWorker } = await import(pathToFileURL(join(packageRoot, "src/integration.mjs")));
const client = await readFile(join(packageRoot, "src/client.js"));
const browser = await chromium.launch();
async function scenario(transformInitially, rejectUpdate, replaceWaiting = false) {
  const root = await mkdtemp(join(tmpdir(), "offline-lifecycle-"));
  const build = async (marker) => {
    await writeFile(join(root, "index.html"), `<h1>${marker}</h1><a href="mailto:neutral@example.invalid">Contact</a>`);
    return generateOfflineWorker(root, {
      cachePrefix: "lifecycle-proof-",
      globPatterns: ["index.html"],
      maxBytes: 4096,
    });
  };
  const first = await build("build A");
  let transformed = transformInitially;
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", pathname.endsWith(".js") ? "text/javascript" : "text/html");
      if (pathname === "/client.js") return response.end(client);
      const body = await readFile(join(root, pathname === "/sw.js" ? "sw.js" : "index.html"));
      // Simulate deployment-time HTML rewriting, including revision-query fetches.
      response.end(transformed && pathname !== "/sw.js"
        ? body.toString().replace("mailto:neutral@example.invalid", "/cdn-cgi/l/email-protection#changed")
        : body);
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(async () => {
      window.registrationStates = [];
      window.lifecycle = [];
      const { installOfflineRegistration } = await import("/client.js");
      window.stopRegistration = installOfflineRegistration({
        workerURL: "/sw.js",
        onState: (state) => window.registrationStates.push(state),
        onLifecycle: (state, details) => window.lifecycle.push({
          state,
          ...details,
          error: details.error?.message,
        }),
      });
    });
    if (!transformInitially) {
      await page.waitForFunction(() => window.lifecycle.some((event) => event.state === "active"), undefined, { timeout: 5000 });
      assert.equal(await page.evaluate(() => window.lifecycle.some((event) => event.state === "installed")), true);
      if (replaceWaiting) {
        const controlled = await context.newPage();
        await controlled.goto(origin);
        await controlled.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
        await build("build B");
        await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
        await page.waitForFunction(() => window.lifecycle.filter((event) => event.state === "installed").length === 2, undefined, { timeout: 5000 });
        await page.evaluate(async () => { window.previousWaiting = (await navigator.serviceWorker.getRegistration()).waiting; });
        assert.equal(await page.evaluate(() => window.previousWaiting.state), "installed");
        await build("build C");
        await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
        await page.waitForFunction(() => window.lifecycle.filter((event) => event.state === "installed").length === 3, undefined, { timeout: 5000 });
        assert.equal(await page.evaluate(() => window.previousWaiting.state), "redundant");
        assert.equal(await page.evaluate(() => window.lifecycle.some((event) => event.state === "failed")), false);
        console.log("PASS real waiting worker replacement is not reported as installation failure");
        return;
      }
      if (rejectUpdate) {
        await build("build B");
        transformed = true;
        await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      } else {
        await context.setOffline(true);
        const offlinePage = await context.newPage();
        await offlinePage.goto(origin + "/index.html");
        assert.equal(await offlinePage.locator("h1").textContent(), "build A");
        console.log("PASS actual byte-stable worker installation/activation and offline document");
        return;
      }
    }
    await page.waitForFunction(() => window.lifecycle.some((event) => event.state === "failed"), undefined, { timeout: 5000 });
    const result = await page.evaluate(async () => ({
      registrationStates: window.registrationStates,
      lifecycle: window.lifecycle,
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
      caches: await caches.keys(),
    }));
    assert.ok(result.registrationStates.includes("registered"), "Compatibility callback retains registration acceptance");
    const failure = result.lifecycle.find((event) => event.state === "failed");
    assert.match(failure.error, /redundant before activation/);
    assert.equal(failure.hasActiveWorker, rejectUpdate);
    assert.equal(result.registrations, rejectUpdate ? 1 : 0);
    assert.deepEqual(result.caches, rejectUpdate ? ["lifecycle-proof-" + first.revision] : []);
    console.log("PASS actual transformed HTML rejected with surfaced failure and " + (rejectUpdate ? "previous active corpus retained" : "zero registrations/caches"));
  } finally {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
try {
  await scenario(true, false);
  await scenario(false, false);
  await scenario(false, true);
  await scenario(false, false, true);
} finally {
  await browser.close();
}
