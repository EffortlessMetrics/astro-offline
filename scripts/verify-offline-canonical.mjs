import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
const { generateOfflineWorker } = await import(process.env.OFFLINE_PACKAGE_ROOT
  ? pathToFileURL(join(process.env.OFFLINE_PACKAGE_ROOT, "src/integration.mjs")).href
  : "../src/integration.mjs");
const root = await mkdtemp(join(tmpdir(), "offline-canonical-"));
const browser = await chromium.launch();
try {
  for (const strategy of ["cache-first", "network-first"]) {
    for (const stripQuery of [false, true]) {
      const policy = {
        cachePrefix: "canonical-contract-", workerFile: "sw.js",
        pages: ["/", "/article/", "/offline/"], globPatterns: ["article/*.js"],
        maxResources: 8, maxBytes: 8192,
        worker: { navigationStrategy: strategy, stripQuery, navigationFallback: "/offline/", navigationTimeoutMs: 100, excludedPrefixes: ["/private/"] },
      };
      const receipts = {};
      for (const version of ["a", "b"]) {
        const dir = join(root, strategy + stripQuery, version);
        for (const route of ["", "article", "offline"]) {
          await mkdir(join(dir, route), { recursive: true });
          await writeFile(join(dir, route, "index.html"), `<h1>${route === "offline" ? "Offline" : version}</h1>${route === "article" ? '<script src="./relative.js"></script>' : ''}<script>navigator.serviceWorker.register('/sw.js', {updateViaCache:'none'});</script>`);
        }
        await writeFile(join(dir, "article/relative.js"), `window.relativeVersion=${JSON.stringify(version)};`);
        if (version === "a") receipts.a = await generateOfflineWorker(dir, policy);
      }
      let serving = "a", disconnected = false;
      const server = createServer(async (req, res) => {
        if (disconnected) { req.socket.destroy(); return; }
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/article") { res.writeHead(301, { Location: "/article/" + url.search, "Cache-Control": "no-store" }).end(); return; }
        if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/private")) { res.writeHead(503).end("Excluded"); return; }
        try {
          // Hold the worker release at A while online document bytes change.
          // Replacement installation/activation belongs to the freshness suite.
          const file = join(root, strategy + stripQuery, url.pathname === "/sw.js" ? "a" : serving, url.pathname, ...(url.pathname.endsWith("/") ? ["index.html"] : []));
          res.writeHead(200, { "Content-Type": url.pathname.endsWith(".js") ? "text/javascript" : "text/html", "Cache-Control": "no-store" }).end(await readFile(file));
        } catch { res.writeHead(404).end("Missing"); }
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(origin);
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.reload();
        await page.waitForFunction(() => navigator.serviceWorker.controller);
        const held = await context.newPage();
        await held.goto(origin);
        await held.waitForFunction(() => navigator.serviceWorker.controller);
        const before = await page.evaluate(async revision => {
          const cache = await caches.open("canonical-contract-" + revision);
          return Promise.all((await cache.keys()).map(async req => [req.url, await (await cache.match(req)).text()]));
        }, receipts.a.revision);
        disconnected = true;
        await context.setOffline(true);
        for (const path of ["/article/", "/article"]) {
          await page.goto(origin + path);
          assert.equal(await page.locator("h1").textContent(), "a", `${strategy}: ${path} must read verified article`);
          assert.equal(new URL(page.url()).pathname, "/article/");
          assert.equal(await page.evaluate(() => window.relativeVersion), "a");
        }
        for (const path of ["/article?proof=1", "/article/?proof=1"]) {
          await page.goto(origin + path);
          assert.equal(await page.locator("h1").textContent(), stripQuery ? "a" : "Offline");
          if (stripQuery) assert.equal(new URL(page.url()).search, "?proof=1");
        }
        await assert.rejects(page.evaluate(() => fetch("/article").then(r => r.text())));
        for (const path of ["/api", "/api/", "/api/contact", "/api?proof=1", "/private/route"]) {
          const child = await context.newPage();
          try { await assert.rejects(child.goto(origin + path)); } finally { await child.close(); }
        }
        await page.goto(origin + "/missing");
        assert.equal(await page.locator("h1").textContent(), "Offline");
        await context.setOffline(false);
        disconnected = false;
        serving = "b";
        await page.goto(origin + "/article");
        assert.equal(await page.locator("h1").textContent(), strategy === "network-first" ? "b" : "a");
        assert.equal(new URL(page.url()).pathname, "/article/");
        const after = await page.evaluate(async revision => {
          const cache = await caches.open("canonical-contract-" + revision);
          return Promise.all((await cache.keys()).map(async req => [req.url, await (await cache.match(req)).text()]));
        }, receipts.a.revision);
        assert.deepEqual(after, before, "Online redirects never mutate verified active corpus");
        // This matrix isolates aliases under a fixed active corpus.
        disconnected = true;
        await context.setOffline(true);
        for (const path of ["/article/", "/article"]) {
          await page.goto(origin + path);
          assert.equal(await page.locator("h1").textContent(), "a");
          assert.equal(await page.evaluate(() => window.relativeVersion), "a");
        }
        console.log(JSON.stringify({ strategy, stripQuery, canonicalOffline: true, relativeAssets: true, exclusions: true, reconnect: true, immutableActiveCorpus: true }));
      } finally {
        await context.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }
  }
} finally { await browser.close(); }
