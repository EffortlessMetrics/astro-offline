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
  for (const corpus of ["directory", "index-file"]) {
  for (const strategy of ["cache-first", "network-first"]) {
    for (const stripQuery of [false, true]) {
      const policy = {
        cachePrefix: "canonical-contract-", workerFile: "sw.js",
        pages: corpus === "directory" ? ["/", "/article/", "/nested/article/", "/with.dot/", "/offline/"] : [],
        globPatterns: ["**/relative.js", "release-index.html", ...(corpus === "index-file" ? ["**/index.html"] : [])],
        maxResources: 16, maxBytes: 16384,
        worker: { navigationStrategy: strategy, stripQuery, navigationFallback: corpus === "directory" ? "/offline/" : "/offline/index.html", navigationTimeoutMs: 100, excludedPrefixes: ["/private/"] },
      };
      const receipts = {};
      for (const version of ["a", "b"]) {
        const dir = join(root, corpus + strategy + stripQuery, version);
        for (const route of ["", "article", "nested/article", "with.dot", "offline"]) {
          await mkdir(join(dir, route), { recursive: true });
          await writeFile(join(dir, route, "index.html"), `<h1>${route === "offline" ? "Offline" : version}</h1>${["article", "nested/article", "with.dot"].includes(route) ? '<script src="./relative.js"></script>' : ''}<script>navigator.serviceWorker.register('/sw.js', {updateViaCache:'none'});</script>`);
          if (["article", "nested/article", "with.dot"].includes(route))
            await writeFile(join(dir, route, "relative.js"), `window.relativeVersion=${JSON.stringify(version)};`);
        }
        await writeFile(join(dir, "release-index.html"), '<h1>Standalone</h1>');
        if (version === "a") receipts.a = await generateOfflineWorker(dir, policy);
      }
      let serving = "a", disconnected = false;
      assert.equal(receipts.a.urls.includes("/article/"), corpus === "directory");
      assert.equal(receipts.a.urls.includes("/article/index.html"), corpus === "index-file");
      const server = createServer(async (req, res) => {
        if (disconnected) { req.socket.destroy(); return; }
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/article") { res.writeHead(301, { Location: "/article/" + url.search, "Cache-Control": "no-store" }).end(); return; }
        if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/private")) { res.writeHead(503).end("Excluded"); return; }
        try {
          // Hold the worker release at A while online document bytes change.
          // Replacement installation/activation belongs to the freshness suite.
          const file = join(root, corpus + strategy + stripQuery, url.pathname === "/sw.js" ? "a" : serving, url.pathname, ...(url.pathname.endsWith("/") ? ["index.html"] : []));
          const body = await readFile(file);
          res.writeHead(200, { "Content-Type": url.pathname.endsWith(".js") ? "text/javascript" : "text/html", "Cache-Control": "no-store" }).end(body);
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
        const directoryPaths = corpus === "directory" ? ["/article/", "/article"] : ["/article/"];
        for (const path of directoryPaths) {
          await page.goto(origin + path);
          assert.equal(await page.locator("h1").textContent(), "a", `${strategy}: ${path} must read verified article`);
          assert.equal(new URL(page.url()).pathname, "/article/");
          assert.equal(await page.evaluate(() => window.relativeVersion), "a");
        }
        const explicitAliases = ["/index.html", "/article/index.html", "/nested/article/index.html", "/with.dot/index.html"];
        for (const path of explicitAliases) {
          await page.goto(origin + path);
          assert.equal(await page.locator("h1").textContent(), "a", `${strategy}: ${path} must read verified directory HTML`);
          assert.equal(new URL(page.url()).pathname, path);
          if (path !== "/index.html") assert.equal(await page.evaluate(() => window.relativeVersion), "a");
        }
        await page.goto(origin + "/release-index.html");
        assert.equal(await page.locator("h1").textContent(), "Standalone");
        for (const path of ["/article?proof=1", "/article/?proof=1", "/article/index.html?proof=1"]) {
          await page.goto(origin + path);
          assert.equal(await page.locator("h1").textContent(), stripQuery ? "a" : "Offline");
          if (stripQuery) assert.equal(new URL(page.url()).search, "?proof=1");
        }
        if (corpus === "directory") {
          await assert.rejects(page.evaluate(() => fetch("/article").then(r => r.text())));
          await assert.rejects(page.evaluate(() => fetch("/article/index.html").then(r => r.text())));
        } else {
          // Retain existing resource matches in an index-file corpus.
          for (const path of ["/article", "/article/index.html"])
            assert.match(await page.evaluate(path => fetch(path).then(r => r.text()), path), /<h1>a<\/h1>/);
        }
        for (const path of ["/api", "/api/", "/api/contact", "/api/index.html", "/api?proof=1", "/private/route", "/private/index.html"]) {
          const child = await context.newPage();
          try { await assert.rejects(child.goto(origin + path)); } finally { await child.close(); }
        }
        await page.goto(origin + "/missing");
        assert.equal(await page.locator("h1").textContent(), "Offline");
        await page.goto(origin + "/article/other.html");
        assert.equal(await page.locator("h1").textContent(), "Offline");
        await context.setOffline(false);
        disconnected = false;
        serving = "b";
        await page.goto(origin + "/article");
        assert.equal(await page.locator("h1").textContent(), strategy === "network-first" ? "b" : "a");
        assert.equal(new URL(page.url()).pathname, strategy === "network-first" || corpus === "directory" ? "/article/" : "/article");
        const after = await page.evaluate(async revision => {
          const cache = await caches.open("canonical-contract-" + revision);
          return Promise.all((await cache.keys()).map(async req => [req.url, await (await cache.match(req)).text()]));
        }, receipts.a.revision);
        assert.deepEqual(after, before, "Online redirects never mutate verified active corpus");
        // Repeat transitions while retaining the same immutable active corpus.
        for (let cycle = 0; cycle < 3; cycle++) {
          disconnected = true;
          await context.setOffline(true);
          for (const path of [...directoryPaths, ...explicitAliases]) {
            await page.goto(origin + path);
            assert.equal(await page.locator("h1").textContent(), "a", `cycle ${cycle}: ${path}`);
            if (path !== "/index.html") assert.equal(await page.evaluate(() => window.relativeVersion), "a");
          }
          disconnected = false;
          await context.setOffline(false);
          for (const path of explicitAliases) {
            await page.goto(origin + path);
            assert.equal(await page.locator("h1").textContent(), strategy === "network-first" ? "b" : "a");
          }
        }
        const finalCorpus = await page.evaluate(async revision => {
          const cache = await caches.open("canonical-contract-" + revision);
          return Promise.all((await cache.keys()).map(async req => [req.url, await (await cache.match(req)).text()]));
        }, receipts.a.revision);
        assert.deepEqual(finalCorpus, before, "Repeated reconnects never mutate verified active corpus");
        console.log(JSON.stringify({ corpus, strategy, stripQuery, canonicalOffline: true, explicitIndexAliases: true, relativeAssets: true, exclusions: true, reconnectCycles: 3, immutableActiveCorpus: true }));
      } finally {
        await context.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }
  }
  }
} finally { await browser.close(); }
