import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
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
const root = await mkdtemp(join(tmpdir(), "offline-incremental-"));
const prefix = "incremental-contract-";
const key = "a".repeat(64), newKey = "b".repeat(64);
const common = { cachePrefix: prefix, globPatterns: ["*.txt"], pages: ["/"], maxBytes: 8192, maxResources: 10 };
let serving = "a", corruptNetwork = false;
const requested = [];
const versions = {};
for (const version of ["a", "b", "c", "d"]) {
  const dir = join(root, version);
  await mkdir(dir);
  await writeFile(join(dir, "index.html"), "<h1>" + version + "</h1>");
  await writeFile(join(dir, "same.txt"), "unchanged");
  await writeFile(join(dir, "corrupt.txt"), "original");
  await writeFile(join(dir, "changed.txt"), version);
  if (version === "a") await writeFile(join(dir, "retired.txt"), "retired");
  if (version !== "a") await writeFile(join(dir, "new.txt"), "retired");
  versions[version] = await generateOfflineWorker(dir, {
    ...common, worker: { claimClients: true, navigationStrategy: "network-first",
      reuseUnchangedPolicyKey: version === "d" ? newKey : key },
  });
}
await assert.rejects(generateOfflineWorker(join(root, "a"), {
  ...common, worker: { reuseUnchangedPolicyKey: "invalid" },
}), /response-policy identity/);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  requested.push(url.pathname);
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  try {
    const body = corruptNetwork && url.pathname === "/changed.txt" ? "wrong-hosted-bytes" : await readFile(join(root, serving, file));
    res.writeHead(200, {
      "Content-Type": file === "sw.js" ? "text/javascript" : file === "index.html" ? "text/html" : "text/plain",
      "Cache-Control": "no-cache",
      "X-Response-Policy": serving === "d" ? "new" : "original",
    }).end(body);
  } catch { res.writeHead(404).end("missing"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch();
const context = await browser.newContext();
try {
  let page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return navigator.serviceWorker.controller && registration.active?.state === "activated";
  });
  const cacheA = prefix + versions.a.revision;
  const cacheB = prefix + versions.b.revision;
  await page.evaluate(async (name) => {
    const cache = await caches.open(name);
    const entry = (await cache.keys()).find((request) => new URL(request.url).pathname === "/corrupt.txt");
    if (!entry) throw new Error("Missing corruption fixture");
    await cache.put(entry, new Response("tampered"));
    const foreign = await caches.open("unrelated-cache");
    await foreign.put("/same.txt", new Response("foreign"));
  }, cacheA);
  async function update(version, expectWaiting) {
    serving = version;
    requested.length = 0;
    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const replacement = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("No replacement worker terminal state")), 30000);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          if (!worker) return;
          const observe = () => {
            if (["installed", "redundant", "activated"].includes(worker.state)) {
              clearTimeout(timeout);
              resolve(worker.state);
            }
          };
          worker.addEventListener("statechange", observe);
          observe();
        }, { once: true });
      });
      await registration.update();
      return replacement;
    });
    console.log(JSON.stringify({ version, terminalState: state, requested }));
    assert.equal(state, expectWaiting ? "installed" : "redundant");
    if (expectWaiting) await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
    else assert.equal(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting)), false);
    return [...requested];
  }
  const bRequests = await update("b", true);
  assert.ok(!bRequests.includes("/same.txt"), "Unchanged verified bytes must not be fetched");
  for (const path of ["/", "/changed.txt", "/corrupt.txt", "/new.txt"])
    assert.ok(bRequests.includes(path), "Required network miss: " + path);
  const cacheCheck = await page.evaluate(async ({ a, b }) => {
    const previous = await caches.open(a);
    const next = await caches.open(b);
    const paths = async (cache) => (await cache.keys()).map((request) => new URL(request.url).pathname);
    const text = async (cache, pathname) => {
      const req = (await cache.keys()).find((request) => new URL(request.url).pathname === pathname);
      return req ? (await cache.match(req)).text() : null;
    };
    return { old: await paths(previous), next: await paths(next), oldChanged: await text(previous, "/changed.txt"), repaired: await text(next, "/corrupt.txt"), same: await text(next, "/same.txt") };
  }, { a: cacheA, b: cacheB });
  assert.ok(cacheCheck.old.includes("/retired.txt"));
  assert.ok(!cacheCheck.next.includes("/retired.txt"));
  assert.equal(cacheCheck.oldChanged, "a");
  assert.equal(cacheCheck.repaired, "original");
  assert.equal(cacheCheck.same, "unchanged");
  async function activateWaiting() {
    const replacement = context.serviceWorkers().findLast((worker) => worker.url() === origin + "/sw.js");
    assert.ok(replacement);
    await page.close();
    await replacement.evaluate(async () => {
      const deadline = Date.now() + 30000;
      while (self.registration.active?.state !== "activated" || self.registration.waiting) {
        if (Date.now() > deadline) throw new Error("Natural activation timed out");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });
    page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
  }
  await activateWaiting();
  assert.ok(!(await page.evaluate(() => caches.keys())).includes(cacheA));
  corruptNetwork = true;
  await update("c", false);
  assert.ok((await page.evaluate(() => caches.keys())).includes(cacheB));
  assert.ok(!(await page.evaluate(() => caches.keys())).includes(prefix + versions.c.revision));
  await context.setOffline(true);
  await page.goto(origin);
  assert.equal(await page.locator("h1").textContent(), "b");
  assert.equal(await page.evaluate(async () => (await fetch("/same.txt")).text()), "unchanged");
  await context.setOffline(false);
  corruptNetwork = false;
  const dRequests = await update("d", true);
  for (const path of ["/", "/same.txt", "/changed.txt", "/corrupt.txt", "/new.txt"])
    assert.ok(dRequests.includes(path), "Policy change must refetch: " + path);
  await activateWaiting();
  await context.setOffline(true);
  assert.equal(await page.evaluate(async () => (await fetch("/same.txt")).headers.get("x-response-policy")), "new");
  await page.goto(origin);
  assert.equal(await page.locator("h1").textContent(), "d");
  assert.ok((await page.evaluate(() => caches.keys())).includes("unrelated-cache"));
  console.log(JSON.stringify({ pass: true, bRequests, dRequests, versions }, null, 2));
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
