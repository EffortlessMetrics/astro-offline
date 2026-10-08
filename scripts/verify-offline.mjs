import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile, mkdtemp } from "node:fs/promises";
import { join, extname } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
const packageRoot =
  process.env.OFFLINE_PACKAGE_ROOT ??
  fileURLToPath(new URL("../", import.meta.url));
const { generateOfflineWorker } = await import(
  pathToFileURL(join(packageRoot, "src/integration.mjs")).href
);
const root =
  process.env.OFFLINE_TEST_ROOT ?? (await mkdtemp(join(tmpdir(), "shared-offline-contract-")));
let serving = root + "/one",
  mixed = false;
for (const version of ["one", "two"]) {
  const dir = root + "/" + version;
  await mkdir(dir + "/work", { recursive: true });
  await mkdir(dir + "/offline", { recursive: true });
  for (const route of ["", "work", "offline"])
    await writeFile(
      join(dir, route, "index.html"),
      "<h1>" + version + '</h1><script src="/asset.js"></script>',
    );
  await writeFile(dir + "/asset.js", "window.assetVersion=" + JSON.stringify(version) + ";");
}
const policy = {
  cachePrefix: "contract-offline-",
  workerFile: "sw.js",
  pages: ["/", "/work/", "/offline/"],
  globPatterns: ["asset.js"],
  maxBytes: 4096,
  maxResources: 10,
  worker: {
    claimClients: process.env.OFFLINE_CLAIM_CLIENTS === "true" || process.argv.includes("--claim"),
    excludedPrefixes: ["/api/"],
    navigationFallback: "/offline/",
    navigationTimeoutMs: 100,
  },
};
const one = await generateOfflineWorker(root + "/one", policy),
  two = await generateOfflineWorker(root + "/two", policy);
assert.notEqual(one.revision, two.revision);
assert.match(await readFile(root + "/one/sw.js", "utf8"), /Copyright 2018 Google LLC/);
assert.match(await readFile(root + "/one/sw.js", "utf8"), /Permission is hereby granted/);
assert.ok(
  (await readFile(root + "/one/sw.js", "utf8")).includes(
    (await readFile(join(packageRoot, "LICENSE-MIT"), "utf8")).trim(),
  ),
  "Complete owner permission notice retained",
);
assert.ok(
  (await readFile(root + "/one/sw.js", "utf8")).includes(
    (await readFile(join(packageRoot, "WORKBOX-LICENSE"), "utf8")).trim(),
  ),
  "Complete Workbox permission notice retained",
);
await assert.rejects(generateOfflineWorker(root + "/one", { ...policy, maxBytes: 1 }), /budget/);
await assert.rejects(
  generateOfflineWorker(root + "/one", { ...policy, maxResources: 1 }),
  /budget/,
);
async function poll(predicate, message) {
  const deadline = Date.now() + 30000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/missing/") {
      req.socket.destroy();
      return;
    }
    let p = join(serving, url.pathname);
    if (url.pathname.endsWith("/")) p = join(p, "index.html");
    const body = mixed && url.pathname === "/asset.js" ? "mixed" : await readFile(p);
    res.setHeader(
      "Content-Type",
      { ".html": "text/html", ".js": "text/javascript" }[extname(p)] ?? "text/plain",
    );
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch();
const context = await browser.newContext();
try {
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(Error("worker-ready timeout")), 10000)),
    ]);
    await caches.open("unrelated-contract");
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.goto(origin + "/work/");
  assert.equal(await page.locator("h1").textContent(), "one");
  assert.equal(await page.evaluate(() => window.assetVersion), "one");
  await page.goto(origin + "/missing/");
  assert.equal(await page.locator("h1").textContent(), "one");
  await assert.rejects(page.evaluate(async () => fetch("/api/contact")));
  await context.setOffline(false);
  serving = root + "/two";
  mixed = true;
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration()).update();
  });
  await poll(
    () => page.evaluate(async () => !(await navigator.serviceWorker.getRegistration()).installing),
    "Rejected worker install did not settle",
  );
  assert.equal(
    await page.evaluate(async () =>
      Boolean((await navigator.serviceWorker.getRegistration()).waiting),
    ),
    false,
  );
  await context.setOffline(true);
  await page.goto(origin + "/work/");
  assert.equal(await page.locator("h1").textContent(), "one");
  await context.setOffline(false);
  mixed = false;
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration()).update();
  });
  await poll(
    () =>
      page.evaluate(
        async () =>
          (await navigator.serviceWorker.getRegistration()).waiting?.state === "installed",
      ),
    "New revision did not become an installed waiting worker",
  );
  await context.setOffline(true);
  await page.goto(origin + "/work/");
  assert.equal(await page.locator("h1").textContent(), "one");
  assert.equal(await page.evaluate(() => window.assetVersion), "one");
  await page.close();
  let activated = false;
  const activationDeadline = Date.now() + 30000;
  while (!activated) {
    for (const worker of context.serviceWorkers()) {
      activated = await worker
        .evaluate(
          async ({ oldName, newName }) => {
            const keys = await caches.keys();
            return (
              keys.includes(newName) &&
              !keys.includes(oldName) &&
              self.registration.waiting == null &&
              self.registration.active?.state === "activated"
            );
          },
          {
            oldName: "contract-offline-" + one.revision,
            newName: "contract-offline-" + two.revision,
          },
        )
        .catch(() => false);
      if (activated) break;
    }
    if (Date.now() > activationDeadline)
      throw new Error(
        "Natural activation did not retire old corpus after closing controlled pages",
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await context.setOffline(false);
  const fresh = await context.newPage();
  await fresh.goto(origin);
  await fresh.waitForFunction(() => navigator.serviceWorker.controller);
  await context.setOffline(true);
  await fresh.goto(origin + "/work/");
  assert.equal(await fresh.locator("h1").textContent(), "two");
  assert.equal(await fresh.evaluate(() => window.assetVersion), "two");
  const keys = await fresh.evaluate(() => caches.keys());
  assert.deepEqual(keys.sort(), ["contract-offline-" + two.revision, "unrelated-contract"].sort());
  await writeFile(
    root + "/receipt.json",
    JSON.stringify(
      {
        one,
        two,
        mixedBuildRejected: true,
        waitingOldDocumentAssetCoherence: true,
        naturalActivation: true,
        unrelatedCachePreserved: true,
        offlineFallback: true,
        apiNetworkOnly: true,
        hardBudgets: true,
      },
      null,
      2,
    ),
  );
  console.log("Shared Workbox contract PASS", root + "/receipt.json");
} finally {
  await context.close();
  await browser.close();
  server.close();
}
