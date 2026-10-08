# @effortlessmetrics/astro-offline

Unpublished 0.1.2 standalone repository candidate: reusable Workbox7.4.1 static Astro corpus builds and browser registration. No deployment or registry publication is implied.

Import astroOffline (default) or generateOfflineWorker(directory, policy) from /integration. Import installOfflineRegistration(options) and backgroundDownloadsAllowed from /client. These are separate Node build and browser/SSR-safe entry points; no Node/Workbox build dependencies are imported by the client entry.

Consumers own cache prefixes, clean page allowlists, static asset globs, byte/resource/file/HTML budgets, worker URL/scope, query matching, fallback route/timeout, legacy exact cache names and scope restrictions. They retain contact validation/submission and site identity. API paths are excluded by default; external resources, runtime cache growth, POSTs and queues are not supported. Contact HTML may be part of a corpus without executing CAPTCHA or submitting it.

`worker.navigationStrategy: "network-first"` opts matching document navigations into HTTP revalidation, falling back to the active worker's integrity-checked corpus only on network failure or timeout (`navigationTimeoutMs`, default 1000). Genuine HTTP errors, including 404 and 5xx, remain network responses. Successful online HTML never mutates the offline corpus. The default remains `"cache-first"`. Query and API exclusions remain in force. Static resources remain revision-pinned; new hashed URLs pass through to the network. Mutable resource URLs such as favicons keep the active corpus version until natural activation.

Migration from an already active cache-first worker requires closing its controlled tabs once so the replacement can activate naturally. Merely downloading the new worker or force-reloading one tab cannot change the old worker's fetch policy. No forced activation, draft reload or cache clearing is performed. During a later deployment, an active network-first worker serves current online HTML but offline fallback remains its own verified build until replacement activation.

The generator uses Workbox getManifest and a bundled local PrecacheController. Build revision covers policy, worker implementation and every selected byte. Installation checks SHA-256 for each fetched resource, uses no credentials/redirects, rejects mixed or incomplete builds and deletes only the failed new cache. Cache naming is consumerPrefix+revision; Workbox cache keys have revision queries. New workers wait naturally; no skipWaiting, forced reload or update message capability exists. Optional claimClients preserves a consumer's existing control of open pages after natural activation; it runs only in the activate event and cannot activate a waiting worker. Business leaves it false; personal retains its established behavior. Activation removes only older owned-prefix caches and explicitly listed legacy caches under the configured scope guard.

Registration waits for load, checks online/SaveData/slow2G2G3G/downlink<1.5Mbps/RTT>=500ms, optionally visibility and canRegister, and retries on online/visibility/connection changes. Optional idle scheduling, same-worker reuse and foreign-worker refusal preserve different consumer policies. It returns a disposer. Registration errors allow later retry; onState exposes state/error without requiring console or UI copy.

Qualified Node24.19.x and Astro7.3.5. Source package owner code is MIT OR Apache-2.0. Workbox and esbuild remain dependencies under their own licenses; no vendor CDN worker imports are emitted. Scope/policy changes require consumer qualification and exact previous archive/lock retention for rollback. A successfully installed corpus is required for offline support; no live delivery or production acceptance is claimed.

Generated workers retain the complete pinned Workbox MIT copyright and permission notice. WORKBOX-LICENSE matches all three runtime modules' license SHA-256 aee9670e09b75ca8a2a1fe62d545ae38a6797970caf0335628e3a4dd15bc9b6c. The notice and actual bundled runtime bytes participate in corpus revision identity.

Generated workers also retain the complete owner-code MIT alternative notice, preserving Steven Zimmerman attribution and permission terms. Both complete notices are hashed into worker revision identity.

The exact `/api` endpoint and every `/api/` descendant are always network-only and rejected from explicit static corpus globs. Custom exclusion lists cannot relax that boundary. Ordinary similarly named paths such as `/apiary` are not treated as API endpoints.

This independent repository owns the offline library. AstroMache and Still are template consumers; private websites retain their own content and deployment policy. Source was extracted from public EffortlessMetrics/astromache main bf4095a5b9588a5fb54beee5b28f690531dbce32 with fresh history. The new candidate version identifies repository/provenance changes; runtime APIs and default cache policy are unchanged from 0.1.1.

Development: Node24.19/pnpm10.28, `pnpm install --frozen-lockfile`, `pnpm exec playwright install chromium`, `pnpm test`. Tests use local fixtures and no live email, credentials or deployment.
