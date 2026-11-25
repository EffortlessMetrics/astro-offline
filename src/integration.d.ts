import type { AstroIntegration } from "astro";
export interface WorkerPolicy {
  claimClients?: boolean;
  stripQuery?: boolean;
  excludedPrefixes?: string[];
  legacyCaches?: string[];
  legacyScopePrefixes?: string[];
  legacyRootScopeOnly?: boolean;
  navigationFallback?: string;
  navigationStrategy?: "cache-first" | "network-first";
  navigationTimeoutMs?: number;
  /** Opt-in SHA-256 identity of effective hosted response metadata/routing policy.
   * Reuse only from an activated predecessor with the same identity. */
  reuseUnchangedPolicyKey?: string;
  /** Canonical navigation paths mapped to verified content-addressed offline HTML payloads. */
  offlinePagePayloads?: Record<string, string>;
}
export interface OfflineOptions {
  cachePrefix: string;
  workerFile?: string;
  pages?: string[];
  globPatterns: string[];
  globIgnores?: string[];
  maxResources?: number;
  maxBytes: number;
  maxFileBytes?: number;
  maxHtmlBytes?: number;
  worker?: WorkerPolicy;
  receiptFile?: string;
}
export interface OfflineReceipt {
  revision: string;
  resources: number;
  files: number;
  bytes: number;
  urls: string[];
  largestHtmlBytes: number;
  workbox: string;
}
export declare function generateOfflineWorker(
  directory: string,
  options: OfflineOptions,
): Promise<OfflineReceipt>;
export default function astroOffline(options: OfflineOptions): AstroIntegration;
