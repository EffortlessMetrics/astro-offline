import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

const sha = (x) => createHash("sha256").update(x).digest("hex");
const root = await mkdtemp(join(tmpdir(), "offline-payload-"));
const versions = {};
for (const version of ["a", "b"]) {
  const dir = join(root, version);
  await mkdir(join(dir, "offline-payload"), { recursive: true });
  await mkdir(join(dir, "data"));
  const data = JSON.stringify({ version });
  const dataPath = `/data/${sha(data)}.json`;
  const html = `<h1>${version}</h1><div data-index="${dataPath}"></div>`;
  const payload = `/offline-payload/${sha(html)}.txt`;
  await writeFile(join(dir, payload), html);
  await writeFile(join(dir, dataPath), data);
  const options = { cachePrefix: "payload-test-", globPatterns: ["offline-payload/*.txt", "data/*.json"], maxBytes: 8192, worker: { claimClients: true, navigationStrategy: "network-first", navigationTimeoutMs: 500, offlinePagePayloads: { "/page/": payload } } };
  const receipt = await generateOfflineWorker(dir, options);
  versions[version] = { dir, dataPath, html, payload, receipt, options };
}
await assert.rejects(() => generateOfflineWorker(versions.a.dir, { ...versions.a.options, worker: { ...versions.a.options.worker, navigationStrategy: "cache-first" } }), /require network-first/);
await assert.rejects(() => generateOfflineWorker(versions.a.dir, { ...versions.a.options, worker: { ...versions.a.options.worker, offlinePagePayloads: { "/page/": "/offline-payload/" + "0".repeat(64) + ".txt" } } }), /SHA-256/);
await assert.rejects(() => generateOfflineWorker(versions.a.dir, { ...versions.a.options, worker: { ...versions.a.options.worker, offlinePagePayloads: { "/api/": versions.a.payload } } }), /invalid canonical path/);
await assert.rejects(() => generateOfflineWorker(versions.a.dir, { ...versions.a.options, worker: { ...versions.a.options.worker, offlinePagePayloads: { "/not-canonical": versions.a.payload } } }), /invalid canonical path/);
let active = "a", fault = "", offlinePage = false, payloadRequested = false;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  if (path === "/") { res.setHeader("Content-Type", "text/html"); return res.end('<script>navigator.serviceWorker.register("/sw.js")</script>'); }
  if (path === "/page/") { if (offlinePage) { req.socket.destroy(); return; } res.setHeader("Content-Type", "text/html"); return res.end(versions[active].html + '<span data-provider>Online provider output</span>'); }
  if (fault && path === versions[active].payload) payloadRequested = true;
  if (fault === "missing" && path === versions[active].payload) { res.statusCode = 404; return res.end(); }
  try {
    // Retain release-addressed resources from both releases, regardless of active version.
    const owner = ["a", "b"].find((v) => path === versions[v].dataPath || path === versions[v].payload);
    const file = join(versions[owner ?? active].dir, path);
    let body = await readFile(file);
    if (fault === "corrupt" && path === versions[active].payload) body = Buffer.concat([body, Buffer.from("x")]);
    res.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "text/plain");
    res.setHeader("Content-Security-Policy", "default-src 'self'");
    res.end(body);
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
async function poll(fn) { for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 200)); } throw Error("Timed out waiting for worker state"); }
async function state(page) { return page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { active: !!r?.active, waiting: !!r?.waiting, installing: !!r?.installing, controlled: !!navigator.serviceWorker.controller }; }); }
try {
  const context = await browser.newContext();
  const a = await context.newPage(); await a.goto(origin); await poll(async () => (await state(a)).active); await a.reload(); await poll(async () => (await state(a)).controlled);
  await a.evaluate(() => caches.open("unrelated-cache"));
  const b = await context.newPage(); await b.goto(origin); await poll(async () => (await state(b)).controlled);
  await a.goto(origin + "/page/"); assert.equal(await a.locator("[data-provider]").count(), 1);
  active = "b"; await b.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update()); await poll(async () => (await state(b)).waiting);
  await a.reload(); assert.equal(await a.locator("h1").innerText(), "b"); assert.equal(await a.locator("[data-provider]").count(), 1);
  assert.equal(await a.evaluate(async () => (await (await fetch(document.querySelector("[data-index]").dataset.index)).json()).version), "b");
  offlinePage = true; await context.setOffline(true); const offlineResponse = await a.reload(); assert.equal(await a.locator("h1").innerText(), "a"); assert.equal(await a.locator("[data-provider]").count(), 0); assert.equal(offlineResponse.headers()["content-security-policy"], "default-src 'self'"); assert.match(offlineResponse.headers()["content-type"], /^text\/html/);
  assert.equal(await a.evaluate(async () => (await (await fetch(document.querySelector("[data-index]").dataset.index)).json()).version), "a");
  offlinePage = false; await context.setOffline(false); await a.close(); assert.equal((await state(b)).waiting, true); await b.close();
  const c = await context.newPage(); await c.goto(origin); await poll(async () => { const names = await c.evaluate(() => caches.keys()); return names.includes("payload-test-" + versions.b.receipt.revision) && !names.includes("payload-test-" + versions.a.receipt.revision); });
  await poll(async () => (await state(c)).controlled);
  await c.goto(origin + "/page/"); assert.equal(await c.locator("[data-provider]").count(), 1); offlinePage = true; await context.setOffline(true); await c.reload(); assert.equal(await c.locator("h1").innerText(), "b"); assert.equal(await c.locator("[data-provider]").count(), 0);
  assert.equal(await c.evaluate(async () => (await (await fetch(document.querySelector("[data-index]").dataset.index)).json()).version), "b"); assert.equal(await c.evaluate(async () => (await caches.keys()).includes("unrelated-cache")), true);
  await c.evaluate(async ({ revision, payload }) => { const cache = await caches.open("payload-test-" + revision); const request = (await cache.keys()).find((r) => new URL(r.url).pathname === payload); if (!request) throw new Error("payload missing from test cache"); await cache.put(request, new Response("tampered", { headers: { "Content-Type": "text/plain" } })); }, { revision: versions.b.receipt.revision, payload: versions.b.payload });
  const tamperStored = await c.evaluate(async ({ revision, payload }) => { const cache = await caches.open("payload-test-" + revision); const request = (await cache.keys()).find((r) => new URL(r.url).pathname === payload); return await (await cache.match(request)).text(); }, { revision: versions.b.receipt.revision, payload: versions.b.payload });
  assert.equal(tamperStored, "tampered");
  const tamperedNavigation = await c.goto(origin + "/page/?tamper=1").then((response) => ({ status: response?.status() ?? null, body: c.locator("body").innerText() }), () => ({ status: 0, body: Promise.resolve("") }));
  const tamperedBody = await tamperedNavigation.body;
  assert.equal(tamperedNavigation.status, 0, "tampered cached payload must not produce a document");
  assert.equal(tamperedBody, "");
  await context.close();
  offlinePage = false; for (const mode of ["missing", "corrupt"]) { fault = mode; payloadRequested = false; const isolated = await browser.newContext(); const p = await isolated.newPage(); await p.goto(origin); await poll(async () => payloadRequested); await poll(async () => { const r = await state(p); return !r.installing && !r.waiting && !r.active; }); await poll(async () => !(await p.evaluate(() => caches.keys())).some((x) => x.startsWith("payload-test-"))); await isolated.close(); }
  console.log("Verified payload producer: online response, two-tab activation, offline revisions, retained data, integrity failures, unrelated cache");
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
