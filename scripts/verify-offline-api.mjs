import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
const packageRoot =
  process.env.OFFLINE_PACKAGE_ROOT ??
  fileURLToPath(new URL("../", import.meta.url));
const { generateOfflineWorker } = await import(
  pathToFileURL(join(packageRoot, "src/integration.mjs")).href
);
const root = await mkdtemp(join(tmpdir(), "offline-api-root-"));
await mkdir(join(root, "offline"));
await writeFile(join(root, "index.html"), "<h1>Original document</h1>");
await writeFile(join(root, "offline/index.html"), "<h1>Offline fallback</h1>");
await writeFile(join(root, "api"), "This extensionless endpoint must never be precached");
await writeFile(join(root, "apiary"), "Unrelated similarly named static resource");
const policy = {
  cachePrefix: "api-boundary-",
  workerFile: "sw.js",
  globPatterns: ["index.html", "offline/index.html"],
  maxBytes: 4096,
  maxResources: 10,
  worker: {
    claimClients: process.argv.includes("--claim"),
    excludedPrefixes: [],
    navigationFallback: "/offline/index.html",
    navigationTimeoutMs: 100,
  },
};
let failures = 0;
async function contract(name, run) {
  try {
    await run();
    console.log("PASS", name);
  } catch (error) {
    failures++;
    console.error("FAIL", name, error.message);
  }
}
await contract(
  "mandatory exact API root is rejected even by explicit glob and empty custom exclusions",
  async () => {
    await assert.rejects(
      generateOfflineWorker(root, { ...policy, globPatterns: ["api"] }),
      /excluded endpoint/,
    );
  },
);
await contract("similarly named apiary resource remains eligible", async () => {
  const receipt = await generateOfflineWorker(root, { ...policy, globPatterns: ["apiary"] });
  assert.equal(receipt.resources, 1);
});
await generateOfflineWorker(root, policy);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const file = join(
      root,
      url.pathname.endsWith("/") ? url.pathname + "index.html" : url.pathname,
    );
    response.setHeader(
      "Content-Type",
      extname(file) === ".html"
        ? "text/html"
        : extname(file) === ".js"
          ? "text/javascript"
          : "text/plain",
    );
    response.end(await readFile(file));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch();
const context = await browser.newContext();
try {
  const page = await context.newPage();
  await page.goto(origin + "/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await context.setOffline(true);
  await contract("ordinary offline navigation still receives the configured fallback", async () => {
    const child = await context.newPage();
    try {
      await child.goto(origin + "/missing/");
      assert.equal(await child.locator("h1").textContent(), "Offline fallback");
    } finally {
      await child.close();
    }
  });
  for (const path of ["/api", "/api/", "/api/contact"])
    await contract("API navigation remains network-only: " + path, async () => {
      const child = await context.newPage();
      try {
        await assert.rejects(child.goto(origin + path));
      } finally {
        await child.close();
      }
    });
  await contract("API GET remains network-only", async () => {
    await assert.rejects(page.evaluate(async () => fetch("/api")));
  });
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
assert.equal(failures, 0, `${failures} offline API boundary contracts failed`);
console.log("Offline API-root build and actual worker contracts passed.");
