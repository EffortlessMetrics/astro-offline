import { clientsClaim } from "workbox-core";
import { PrecacheController } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
export function installWorker(policy, entries, revision, prefix) {
  const cacheName = prefix + revision;
  const digests = new Map(
    entries.map((entry) => [new URL(entry.url, self.location.origin).pathname, entry.digest]),
  );
  const controller = new PrecacheController({
    cacheName,
    plugins: [
      {
        requestWillFetch: async ({ request }) =>
          new Request(request, { cache: "reload", credentials: "omit", redirect: "error" }),
        cacheWillUpdate: async ({ request, response }) => {
          if (!response.ok || response.type === "opaque")
            throw new Error("Incomplete offline corpus");
          const expected = digests.get(new URL(request.url).pathname);
          const actual = Array.from(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", await response.clone().arrayBuffer()),
            ),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
          if (actual !== expected) throw new Error("Mixed build offline corpus");
          return response;
        },
      },
    ],
  });
  controller.addToCacheList(entries.map(({ url, digest }) => ({ url, revision: digest })));
  self.addEventListener("install", (event) =>
    event.waitUntil(
      (async () => {
        try {
          await controller.install(event);
        } catch (error) {
          await caches.delete(cacheName);
          throw error;
        }
      })(),
    ),
  );
  self.addEventListener("activate", (event) =>
    event.waitUntil(
      (async () => {
        await controller.activate(event);
        const rootScope = self.registration.scope === self.location.origin + "/";
        const legacy = new Set([
          ...(policy.legacyCaches ?? []),
          ...(policy.legacyScopePrefixes ?? []).map((value) => value + self.registration.scope),
        ]);
        for (const name of await caches.keys())
          if (
            (name.startsWith(prefix) && name !== cacheName) ||
            ((!policy.legacyRootScopeOnly || rootScope) && legacy.has(name))
          )
            await caches.delete(name);
      })(),
    ),
  );
  if (policy.claimClients) clientsClaim();
  const excluded = (path) =>
    path === "/api" ||
    ["/api/", ...(policy.excludedPrefixes ?? [])].some((prefix) => path.startsWith(prefix));
  const candidates = (url) => {
    const clean = new URL(url);
    if (policy.stripQuery) clean.search = "";
    const values = [clean.pathname];
    if (!/\.[^/]+$/.test(clean.pathname))
      values.push(clean.pathname.replace(/\/$/, "") + "/index.html");
    return values;
  };
  registerRoute(
    ({ request, url }) =>
      request.method === "GET" &&
      url.origin === self.location.origin &&
      !excluded(url.pathname) &&
      (policy.stripQuery || !url.search) &&
      candidates(url).some((path) => controller.getCacheKeyForURL(path)),
    async ({ request, url }) => {
      // Keep verified precaches immutable. Online documents revalidate through
      // HTTP; only a transport failure/timeout falls back to this worker's build.
      if (request.mode === "navigate" && policy.navigationStrategy === "network-first") {
        const abort = new AbortController();
        const deadline = setTimeout(() => abort.abort(), policy.navigationTimeoutMs ?? 1000);
        try {
          return await fetch(request, { cache: "no-cache", signal: abort.signal });
        } catch {
          // A real HTTP error response is returned above, never hidden by HTML.
        } finally {
          clearTimeout(deadline);
        }
      }
      for (const path of candidates(url)) {
        const response = await controller.matchPrecache(path);
        if (response) return response;
      }
      return fetch(request);
    },
  );
  if (policy.navigationFallback)
    registerRoute(
      ({ request, url }) =>
        request.mode === "navigate" &&
        url.origin === self.location.origin &&
        !excluded(url.pathname),
      async ({ request }) => {
        const abort = new AbortController();
        const deadline = setTimeout(() => abort.abort(), policy.navigationTimeoutMs ?? 1000);
        try {
          return await fetch(request, { signal: abort.signal });
        } catch (error) {
          const response = await controller.matchPrecache(policy.navigationFallback);
          if (response) return response;
          throw error;
        } finally {
          clearTimeout(deadline);
        }
      },
    );
}
