# Changelog

## 0.1.2 - unpublished independent repository candidate

Move source ownership to EffortlessMetrics/astro-offline, with standalone lockfile, browser contracts and CI. Preserve runtime APIs and cache-first default; consumers may opt into network-first. No registry publication.

## 0.1.1 - unpublished navigation freshness candidate

Add opt-in network-first document navigation with HTTP revalidation and bounded transport-failure fallback to the immutable verified corpus. Preserve cache-first default, real HTTP error responses, query/API exclusions, revision-pinned assets and natural worker activation. Existing cache-first workers require natural activation before the new policy applies.

## 0.1.0 — unpublished extraction candidate

Shared Workbox corpus generation, integrity-checked versioned cache lifecycle, offline navigation fallback and deferred owned registration. Route/corpus/budget/migration/contact policy remains consumer-owned. No forced activation.

Mandatory API exclusions cover both exact `/api` and `/api/` descendants in corpus generation and runtime navigation fallback. Explicit globs/custom exclusions cannot make the API root cacheable; similarly named ordinary routes remain eligible.
