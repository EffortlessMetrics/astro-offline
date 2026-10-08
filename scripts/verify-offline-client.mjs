import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const packageRoot =
  process.env.OFFLINE_PACKAGE_ROOT ??
  fileURLToPath(new URL("../", import.meta.url));
const clientPath = join(packageRoot, "src/client.js");
const { installOfflineRegistration } = await import(pathToFileURL(clientPath).href);
assert.equal(typeof installOfflineRegistration({ workerURL: "/sw.js" }), "function");
const source = await readFile(clientPath);
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/client.js" ? "text/javascript" : "text/html");
  res.end(req.url === "/client.js" ? source : "<h1>client contract</h1>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await page.goto("http://127.0.0.1:" + server.address().port);
  const results = await page.evaluate(async () => {
    const { installOfflineRegistration, backgroundDownloadsAllowed } = await import("/client.js");
    const checks = [];
    const assert = (test, name) => {
      if (!test) throw Error(name);
      checks.push(name);
    };
    for (const hints of [
      { saveData: true },
      { effectiveType: "slow-2g" },
      { effectiveType: "2g" },
      { effectiveType: "3g" },
      { downlink: 1 },
      { rtt: 500 },
    ])
      assert(!backgroundDownloadsAllowed(hints), "network-hint suppression");
    assert(!backgroundDownloadsAllowed({}, false), "offline suppression");
    let calls = 0,
      fail = true;
    const fake = {
      async register() {
        calls++;
        if (fail) throw Error("network");
        return {};
      },
      async getRegistration() {
        return undefined;
      },
    };
    Object.defineProperty(navigator, "serviceWorker", { value: fake, configurable: true });
    const connection = new EventTarget();
    connection.saveData = true;
    Object.defineProperty(navigator, "connection", { value: connection, configurable: true });
    const states = [];
    const stop = installOfflineRegistration({
      workerURL: "/sw.js",
      onState: (s) => states.push(s),
    });
    await new Promise((r) => setTimeout(r, 20));
    assert(calls === 0, "initial deferral");
    connection.saveData = false;
    connection.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 20));
    assert(calls === 1 && states.includes("unavailable"), "failed registration resets");
    fail = false;
    window.dispatchEvent(new Event("online"));
    await new Promise((r) => setTimeout(r, 20));
    assert(calls === 2 && states.includes("registered"), "reconnect retries");
    stop();
    window.dispatchEvent(new Event("online"));
    assert(calls === 2, "disposer");
    calls = 0;
    fake.getRegistration = async () => ({ active: { scriptURL: location.origin + "/foreign.js" } });
    installOfflineRegistration({ workerURL: "/sw.js", ownershipGuard: true });
    await new Promise((r) => setTimeout(r, 20));
    assert(calls === 0, "foreign ownership refusal");
    let releaseOwnership;
    fake.getRegistration = () =>
      new Promise((resolve) => {
        releaseOwnership = resolve;
      });
    const lateStates = [];
    const stopPendingOwnership = installOfflineRegistration({
      workerURL: "/sw.js",
      ownershipGuard: true,
      onState: (state) => lateStates.push(state),
    });
    stopPendingOwnership();
    releaseOwnership({ active: { scriptURL: location.origin + "/foreign.js" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(
      lateStates.length === 1 && lateStates[0] === "registering",
      "disposal suppresses delayed ownership callback",
    );
    fake.getRegistration = async () => undefined;
    let releaseRegistration;
    fake.register = () =>
      new Promise((resolve) => {
        releaseRegistration = resolve;
      });
    const registrationStates = [];
    const stopPendingRegistration = installOfflineRegistration({
      workerURL: "/sw.js",
      onState: (state) => registrationStates.push(state),
    });
    stopPendingRegistration();
    releaseRegistration({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(
      registrationStates.length === 1 && registrationStates[0] === "registering",
      "disposal suppresses delayed registration callback",
    );
    const activeWorker = Object.assign(new EventTarget(), {
      scriptURL: location.origin + "/sw.js",
      state: "activated",
    });
    const registration = Object.assign(new EventTarget(), { active: activeWorker });
    fake.getRegistration = async () => registration;
    const reusedStates = [];
    const reusedLifecycle = [];
    const stopReused = installOfflineRegistration({
      workerURL: "/sw.js",
      reuseExisting: true,
      onState: (state) => reusedStates.push(state),
      onLifecycle: (state) => reusedLifecycle.push(state),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(reusedStates.includes("registered") && reusedLifecycle.includes("active"), "reuse observes an existing activated worker");
    activeWorker.state = "redundant";
    activeWorker.dispatchEvent(new Event("statechange"));
    assert(!reusedLifecycle.includes("failed"), "normal activated worker retirement is not failure");
    stopReused();
    const installingWorker = Object.assign(new EventTarget(), {
      scriptURL: location.origin + "/sw.js",
      state: "installing",
    });
    const installingRegistration = Object.assign(new EventTarget(), { installing: installingWorker });
    fake.getRegistration = async () => installingRegistration;
    const installingLifecycle = [];
    const stopInstalling = installOfflineRegistration({
      workerURL: "/sw.js", reuseExisting: true,
      onLifecycle: (state) => installingLifecycle.push(state),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(installingLifecycle.includes("installing"), "reuse observes incomplete installation");
    installingWorker.state = "redundant";
    installingWorker.dispatchEvent(new Event("statechange"));
    assert(installingLifecycle.includes("failed"), "reused installing worker failure is surfaced");
    stopInstalling();
    const count = installingLifecycle.length;
    installingWorker.state = "activated";
    installingWorker.dispatchEvent(new Event("statechange"));
    installingRegistration.dispatchEvent(new Event("updatefound"));
    assert(installingLifecycle.length === count, "disposer removes worker and registration lifecycle listeners");
    const activatingWorker = Object.assign(new EventTarget(), {scriptURL: location.origin + "/sw.js", state: "activating"});
    fake.getRegistration = async () => ({active: activatingWorker});
    const activationFailures = [];
    const stopActivating = installOfflineRegistration({workerURL: "/sw.js", reuseExisting: true, onLifecycle: (state, details) => {if(state === "failed") activationFailures.push(details.error.message);}});
    await new Promise((resolve) => setTimeout(resolve, 20));
    activatingWorker.state = "redundant";
    activatingWorker.dispatchEvent(new Event("statechange"));
    assert(activationFailures.length === 1 && /during activation/.test(activationFailures[0]), "activation failure is distinguished from waiting replacement");
    stopActivating();
    const trackedTarget = (values) => {
      const target = Object.assign(new EventTarget(), values);
      const attached = new Set();
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      target.addEventListener = (event, fn) => { attached.add(fn); add(event, fn); };
      target.removeEventListener = (event, fn) => { attached.delete(fn); remove(event, fn); };
      target.listenerCount = () => attached.size;
      return target;
    };
    for (const disposeFrom of ["registration", "lifecycle"]) {
      const active = trackedTarget({ scriptURL: location.origin + "/sw.js", state: "activated" });
      const waiting = trackedTarget({ scriptURL: location.origin + "/sw.js", state: "installed" });
      const current = trackedTarget({ active, waiting });
      fake.getRegistration = async () => current;
      let dispose;
      const lifecycle = [];
      dispose = installOfflineRegistration({
        workerURL: "/sw.js", reuseExisting: true,
        onState: (state) => { if (disposeFrom === "registration" && state === "registered") dispose(); },
        onLifecycle: (state) => { lifecycle.push(state); if (disposeFrom === "lifecycle") dispose(); },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert(current.listenerCount() + active.listenerCount() + waiting.listenerCount() === 0, "callback disposal leaves no lifecycle listeners: " + disposeFrom);
      assert(lifecycle.length === (disposeFrom === "registration" ? 0 : 1), "callback disposal suppresses later snapshots: " + disposeFrom);
    }
    return checks;
  });
  const output =
    process.env.OFFLINE_CLIENT_RECEIPT ?? join(tmpdir(), "astro-offline-client-receipt.json");
  await writeFile(output, JSON.stringify({ ssrSafe: true, checks: results }, null, 2));
  console.log("Shared client contracts PASS", results.length);
} finally {
  await browser.close();
  server.close();
}
