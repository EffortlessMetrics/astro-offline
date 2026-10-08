export interface ConnectionHints {
  saveData?: boolean;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}
export declare function backgroundDownloadsAllowed(
  connection?: ConnectionHints,
  online?: boolean,
): boolean;
export interface OfflineRegistrationOptions {
  workerURL: string;
  scope?: string;
  requireVisible?: boolean;
  idle?: boolean;
  ownershipGuard?: boolean;
  reuseExisting?: boolean;
  canRegister?: () => boolean;
  onState?: (
    state: "deferred-connection" | "registering" | "registered" | "foreign-worker" | "unavailable",
    error?: unknown,
  ) => void;
  /** Registration acceptance is not proof of successful offline installation. */
  onLifecycle?: (
    state: "installing" | "installed" | "activating" | "active" | "failed",
    details: {
      workerURL: string;
      hasActiveWorker: boolean;
      controlsPage: boolean;
      /** Redundancy before activation; the browser does not expose its cause. */
      error?: Error;
    },
  ) => void;
}
export declare function installOfflineRegistration(options: OfflineRegistrationOptions): () => void;
