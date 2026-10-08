export function backgroundDownloadsAllowed(connection, online = true) {
  return (
    online &&
    !connection?.saveData &&
    !/^(slow-2g|2g|3g)$/i.test(connection?.effectiveType ?? "") &&
    !(
      typeof connection?.downlink === "number" &&
      connection.downlink > 0 &&
      connection.downlink < 1.5
    ) &&
    !(typeof connection?.rtt === "number" && connection.rtt >= 500)
  );
}
export function installOfflineRegistration(options) {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    !("serviceWorker" in navigator)
  )
    return () => {};
  const {
    workerURL,
    scope = "/",
    requireVisible = false,
    idle = false,
    ownershipGuard = false,
    reuseExisting = false,
    onState = () => {},
    onLifecycle,
    canRegister,
  } = options;
  const connection = navigator.connection;
  let loaded = document.readyState === "complete",
    started = false,
    disposed = false,
    timer;
  const listeners = [];
  const listen = (target, event, fn) => {
    if (disposed) return;
    target?.addEventListener?.(event, fn);
    listeners.push(() => target?.removeEventListener?.(event, fn));
  };
  const allowed = () =>
    backgroundDownloadsAllowed(connection, navigator.onLine) &&
    (!requireVisible || document.visibilityState === "visible") &&
    canRegister?.() !== false;
  const observeRegistration = (registration) => {
    if (disposed || !onLifecycle || !registration) return;
    const observed = new Set();
    const observe = (worker) => {
      if (disposed || !worker || observed.has(worker)) return;
      observed.add(worker);
      let previous;
      let activated = worker.state === "activated";
      const report = () => {
        if (disposed || worker.state === previous) return;
        previous = worker.state;
        if (worker.state === "activated") activated = true;
        // Retirement of a previously active worker is normal replacement.
        if (worker.state === "redundant" && activated) return;
        const state = {
          installing: "installing",
          installed: "installed",
          activating: "activating",
          activated: "active",
          redundant: "failed",
        }[worker.state];
        if (state)
          onLifecycle(state, {
            workerURL: worker.scriptURL,
            hasActiveWorker: registration.active?.state === "activated",
            controlsPage: navigator.serviceWorker.controller === worker,
            ...(state === "failed"
              ? { error: new Error("Service worker became redundant before activation") }
              : {}),
          });
      };
      listen(worker, "statechange", report);
      report();
    };
    const snapshot = () => {
      observe(registration.active);
      observe(registration.waiting);
      observe(registration.installing);
    };
    listen(registration, "updatefound", snapshot);
    snapshot();
  };
  const register = async () => {
    if (disposed || !loaded || started) return;
    if (!allowed()) {
      onState("deferred-connection");
      return;
    }
    started = true;
    onState("registering");
    try {
      if (ownershipGuard || reuseExisting) {
        const current = await navigator.serviceWorker.getRegistration(scope);
        if (disposed) return;
        const workers = [current?.active, current?.waiting, current?.installing].filter(Boolean);
        if (
          ownershipGuard &&
          workers.some((worker) => worker.scriptURL !== new URL(workerURL, location.href).href)
        ) {
          onState("foreign-worker");
          return;
        }
        if (reuseExisting && workers.length) {
          onState("registered");
          observeRegistration(current);
          return;
        }
      }
      if (disposed) return;
      const registration = await navigator.serviceWorker.register(workerURL, {
        scope,
        updateViaCache: "none",
      });
      if (!disposed) {
        onState("registered");
        observeRegistration(registration);
      }
    } catch (error) {
      started = false;
      if (!disposed) onState("unavailable", error);
    }
  };
  const schedule = () => {
    if (disposed || !loaded || started) return;
    if (!allowed()) {
      onState("deferred-connection");
      return;
    }
    if (!idle) {
      void register();
      return;
    }
    if (timer !== undefined) return;
    const run = () => {
      timer = undefined;
      void register();
    };
    timer =
      "requestIdleCallback" in window
        ? window.requestIdleCallback(run, { timeout: 2000 })
        : setTimeout(run, 200);
  };
  listen(window, "load", () => {
    loaded = true;
    schedule();
  });
  listen(window, "online", schedule);
  listen(document, "visibilitychange", schedule);
  listen(connection, "change", schedule);
  schedule();
  return () => {
    disposed = true;
    for (const remove of listeners) remove();
    if (timer !== undefined) {
      if ("cancelIdleCallback" in window && idle) window.cancelIdleCallback(timer);
      else clearTimeout(timer);
    }
  };
}
