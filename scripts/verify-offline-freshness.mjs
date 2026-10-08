import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
const { generateOfflineWorker } = await import(
  process.env.OFFLINE_PACKAGE_ROOT
    ? pathToFileURL(join(process.env.OFFLINE_PACKAGE_ROOT, "src/integration.mjs")).href
    : "../src/integration.mjs"
);

// Use the actual immutable business archive implementation for migration.
const legacyRoot = process.env.OFFLINE_LEGACY_PACKAGE_ROOT;
const root = await mkdtemp(join(tmpdir(), "offline-freshness-"));
const policy = {
  cachePrefix: "freshness-contract-",
  workerFile: "sw.js",
  pages: ["/", "/contact/"],
  globPatterns: ["_astro/*.js", "favicon.svg"],
  maxResources: 10,
  maxBytes: 8192,
  worker: { navigationStrategy: "network-first", navigationTimeoutMs: 200 },
};
let serving = "a",
  failure = "",
  mixed = false;
const states = [];
const requests = [];
for (const version of ["a", "b", "c"]) {
  const dir = join(root, version);
  await mkdir(join(dir, "contact"), { recursive: true });
  await mkdir(join(dir, "_astro"));
  for (const route of ["", "contact"])
    await writeFile(
      join(dir, route, "index.html"),
      `<h1>${version}</h1><textarea></textarea><script src="/_astro/${version}.js"></script>`,
    );
  await writeFile(
    join(dir, "_astro", `${version}.js`),
    `window.assetVersion=${JSON.stringify(version)};`,
  );
  await writeFile(
    join(dir, "favicon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg"><title>${version}</title></svg>`,
  );
}
const fixtureURL = new URL("./fixtures/offline-0.1.0-sw.txt", import.meta.url);
let legacy;
if (legacyRoot) {
  const { generateOfflineWorker: generateLegacy } = await import(
    pathToFileURL(join(legacyRoot, "src/integration.mjs")).href
  );
  legacy = await generateLegacy(join(root, "a"), { ...policy, worker: {} });
  if (process.env.OFFLINE_SAVE_LEGACY_FIXTURE === "true") {
    await mkdir(new URL("./fixtures/", import.meta.url), { recursive: true });
    await writeFile(fixtureURL, await readFile(join(root, "a", "sw.js")));
  }
} else {
  const frozen = await readFile(fixtureURL, "utf8");
  legacy = { revision: /const REVISION="([a-f0-9]+)"/.exec(frozen)[1] };
  await writeFile(join(root, "a", "sw.js"), frozen);
}
const b = await generateOfflineWorker(join(root, "b"), policy);
const c = await generateOfflineWorker(join(root, "c"), policy);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  requests.push(url.pathname);
  if (failure === "disconnect" && url.pathname === "/") {
    req.socket.destroy();
    return;
  }
  if (failure === "timeout" && url.pathname === "/") {
    setTimeout(() => res.end("late"), 500);
    return;
  }
  if (failure === "404" || failure === "503") {
    res.writeHead(Number(failure)).end(failure);
    return;
  }
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    res.writeHead(503).end("api");
    return;
  }
  try {
    const path = join(
      root,
      serving,
      url.pathname,
      ...(url.pathname.endsWith("/") ? ["index.html"] : []),
    );
    const body = mixed && url.pathname === "/contact/" ? "mixed" : await readFile(path);
    res
      .writeHead(200, {
        "Content-Type": url.pathname.endsWith(".js") ? "text/javascript" : "text/html",
        "Cache-Control": "public, max-age=0, must-revalidate",
      })
      .end(body);
  } catch {
    res.writeHead(404).end("missing");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext();
try {
  let page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.evaluate(() => caches.open("unrelated-owned-cache"));
  const tab = await context.newPage();
  await tab.goto(origin + "/contact/");
  await tab.locator("textarea").fill("Preserve draft");
  serving = "b";
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration()).update();
  });
  await page.waitForFunction(async () =>
    Boolean((await navigator.serviceWorker.getRegistration()).waiting),
  );
  await page.reload();
  assert.equal(await page.locator("h1").textContent(), "a");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setBypassServiceWorker", { bypass: true });
  await Promise.all([page.waitForEvent("load"), cdp.send("Page.reload", { ignoreCache: true })]);
  assert.equal(await page.locator("h1").textContent(), "b");
  await cdp.send("Network.setBypassServiceWorker", { bypass: false });
  await page.reload();
  assert.equal(await page.locator("h1").textContent(), "a");
  assert.equal(await tab.locator("textarea").inputValue(), "Preserve draft");
  states.push({
    kind: "actual-production-legacy-reload-force-reload-reload",
    versions: ["a", "b", "a"],
    legacyRevision: legacy.revision,
    waitingRevision: b.revision,
  });
  console.log(JSON.stringify(states.at(-1)));
  const replacement = context
    .serviceWorkers()
    .findLast((worker) => worker.url() === origin + "/sw.js");
  assert.ok(replacement);
  await page.close();
  await tab.close();
  await replacement.evaluate(async () => {
    const deadline = Date.now() + 30000;
    while (self.registration.active?.state !== "activated" || self.registration.waiting) {
      if (Date.now() > deadline) throw new Error("Natural activation timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
  page = await context.newPage();
  await page.goto(origin);
  assert.equal(await page.locator("h1").textContent(), "b");
  const draft = await context.newPage();
  await draft.goto(origin + "/contact/");
  await draft.locator("textarea").fill("Still preserved");
  const before = await page.evaluate(async () => {
    const cache = await caches.open(
      (await caches.keys()).find((key) => key.startsWith("freshness-contract-")),
    );
    return Promise.all(
      (await cache.keys()).map(async (req) => [req.url, await (await cache.match(req)).text()]),
    );
  });
  serving = "c";
  await page.reload();
  assert.equal(
    await page.locator("h1").textContent(),
    "c",
    "Online ordinary reload must fetch current deployment",
  );
  assert.equal(
    await page.evaluate(() => window.assetVersion),
    "c",
    "New hashed asset passes through network",
  );
  const freshCdp = await context.newCDPSession(page);
  await freshCdp.send("Network.enable");
  await freshCdp.send("Network.setBypassServiceWorker", { bypass: true });
  await Promise.all([
    page.waitForEvent("load"),
    freshCdp.send("Page.reload", { ignoreCache: true }),
  ]);
  assert.equal(await page.locator("h1").textContent(), "c");
  await freshCdp.send("Network.setBypassServiceWorker", { bypass: false });
  await page.reload();
  assert.equal(
    await page.locator("h1").textContent(),
    "c",
    "Force reload cannot reintroduce stale HTML",
  );
  mixed = true;
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration()).update();
  });
  await page.waitForFunction(
    async () => !(await navigator.serviceWorker.getRegistration()).installing,
  );
  assert.equal(
    await page.evaluate(async () =>
      Boolean((await navigator.serviceWorker.getRegistration()).waiting),
    ),
    false,
    "Mixed replacement cannot install",
  );
  assert.ok(
    (await page.evaluate(() => caches.keys())).includes("freshness-contract-" + b.revision),
  );
  mixed = false;
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration()).update();
  });
  await page.waitForFunction(async () =>
    Boolean((await navigator.serviceWorker.getRegistration()).waiting),
  );
  assert.equal(await draft.locator("textarea").inputValue(), "Still preserved");
  await page.goto(origin + "/?query=1");
  assert.equal(await page.locator("h1").textContent(), "c");
  for (const status of ["404", "503"]) {
    failure = status;
    const response = await page.goto(origin);
    assert.equal(response.status(), Number(status));
    assert.equal(await page.locator("body").textContent(), status);
  }
  for (const error of ["disconnect", "timeout"]) {
    failure = error;
    await page.goto(origin);
    assert.equal(await page.locator("h1").textContent(), "b");
    assert.equal(await page.evaluate(() => window.assetVersion), "b");
  }
  failure = "";
  await context.setOffline(true);
  await page.goto(origin);
  assert.equal(await page.locator("h1").textContent(), "b");
  assert.equal(await page.evaluate(() => window.assetVersion), "b");
  await assert.rejects(page.evaluate(() => fetch("/api/contact")));
  await assert.rejects(page.goto(origin + "/?query=1"));
  await context.setOffline(false);
  await page.goto(origin);
  assert.equal(await page.locator("h1").textContent(), "c");
  const after = await page.evaluate(async (revision) => {
    const cache = await caches.open("freshness-contract-" + revision);
    return Promise.all(
      (await cache.keys()).map(async (req) => [req.url, await (await cache.match(req)).text()]),
    );
  }, b.revision);
  assert.deepEqual(after, before, "Network HTML must never mutate verified offline corpus");
  assert.ok((await page.evaluate(() => caches.keys())).includes("unrelated-owned-cache"));
  states.push({
    kind: "network-first-active-b-online-c-reloads-offline-b-and-reconnect-c",
    pass: true,
    bRevision: b.revision,
    cRevision: c.revision,
    requests,
  });
  console.log(JSON.stringify({ pass: true, states }, null, 2));
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
