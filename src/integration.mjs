import { getManifest } from "workbox-build";
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const workerSource = fileURLToPath(new URL("./worker.mjs", import.meta.url));
export async function generateOfflineWorker(directory, options) {
  const {
    cachePrefix,
    workerFile = "sw.js",
    globPatterns,
    globIgnores = [],
    pages = [],
    maxResources = Infinity,
    maxBytes,
    maxFileBytes = 2 * 1024 * 1024,
    maxHtmlBytes = Infinity,
    worker = {},
    receiptFile,
  } = options;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*-$/.test(cachePrefix) ||
    !/^[a-zA-Z0-9_-]+\.js$/.test(workerFile) ||
    !(maxBytes > 0)
  )
    throw new Error("Offline requires an owned cache prefix, worker filename and byte budget");
  if (
    worker.navigationStrategy !== undefined &&
    !["cache-first", "network-first"].includes(worker.navigationStrategy)
  )
    throw new Error("Unknown offline navigation strategy");
  const manifest = await getManifest({
    globDirectory: directory,
    globPatterns,
    globIgnores: [...globIgnores, workerFile, ...(receiptFile ? [receiptFile] : [])],
    maximumFileSizeToCacheInBytes: maxFileBytes,
  });
  if (manifest.warnings.length) throw new Error(manifest.warnings.join("\n"));
  const paths = new Map(
    manifest.manifestEntries.map((entry) => ["/" + entry.url, join(directory, entry.url)]),
  );
  for (const url of pages) {
    if (
      !url.startsWith("/") ||
      url.includes("?") ||
      url.includes("#") ||
      url.includes("..") ||
      !url.endsWith("/")
    )
      throw new Error("Offline pages must be clean root-relative directory URLs");
    paths.set(url, join(directory, url.slice(1), "index.html"));
  }
  const excluded = (path) =>
    path === "/api" ||
    ["/api/", ...(worker.excludedPrefixes ?? [])].some((prefix) => path.startsWith(prefix));
  const entries = [];
  let bytes = 0,
    largestHtmlBytes = 0;
  const workboxNotice = await readFile(new URL("../WORKBOX-LICENSE", import.meta.url), "utf8");
  const ownerNotice = await readFile(new URL("../LICENSE-MIT", import.meta.url), "utf8");
  const revisionHash = createHash("sha256")
    .update(await readFile(workerSource))
    .update(await readFile(fileURLToPath(import.meta.url)))
    .update(JSON.stringify(options))
    .update(workboxNotice)
    .update(ownerNotice);
  for (const [url, path] of [...paths].sort(([a], [b]) => a.localeCompare(b))) {
    if (excluded(url)) throw new Error("Offline corpus includes excluded endpoint");
    const body = await readFile(path);
    if (body.length > maxFileBytes) throw new Error("Offline resource exceeds file budget");
    bytes += body.length;
    if (path.endsWith(".html")) largestHtmlBytes = Math.max(largestHtmlBytes, body.length);
    const digest = createHash("sha256").update(body).digest("hex");
    revisionHash.update(url).update(body);
    entries.push({ url, digest });
  }
  if (entries.length > maxResources || bytes > maxBytes || largestHtmlBytes > maxHtmlBytes)
    throw new Error("Offline corpus exceeds resource, byte or HTML budget");
  const bundled = await build({
    entryPoints: [workerSource],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "OfflineRuntime",
    platform: "browser",
    target: "es2022",
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  revisionHash.update(bundled.outputFiles[0].contents);
  const revision = revisionHash.digest("hex").slice(0, 20);
  const diagnostics =
    "const REVISION=" +
    JSON.stringify(revision) +
    ";const PREFIX=" +
    JSON.stringify(cachePrefix) +
    ";const CACHE=PREFIX+REVISION;const URLS=" +
    JSON.stringify(entries.map((entry) => entry.url)) +
    ";const DIGESTS=" +
    JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.url, entry.digest]))) +
    ";\n";
  await writeFile(
    join(directory, workerFile),
    "/*! @effortlessmetrics/astro-offline owner code - MIT alternative\n" +
      ownerNotice +
      "\n*/\n" +
      "/*! Workbox7.4.1 — MIT license\n" +
      workboxNotice +
      "\n*/\n" +
      diagnostics +
      bundled.outputFiles[0].text +
      "\nOfflineRuntime.installWorker(" +
      [JSON.stringify(worker), JSON.stringify(entries), "REVISION", "PREFIX"].join(",") +
      ");",
  );
  const receipt = {
    revision,
    resources: entries.length,
    files: entries.length,
    bytes,
    urls: entries.map((entry) => entry.url),
    largestHtmlBytes,
    workbox: "7.4.1",
  };
  if (receiptFile) await writeFile(join(directory, receiptFile), JSON.stringify(receipt, null, 2));
  return receipt;
}
export default function astroOffline(options) {
  return {
    name: "shared-static-offline",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        await generateOfflineWorker(fileURLToPath(dir), options);
      },
    },
  };
}
