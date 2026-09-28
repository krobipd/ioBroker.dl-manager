// This file extends the AdapterConfig type from "@iobroker/types"

declare global {
  namespace ioBroker {
    interface AdapterConfig {
      /** The settings table, one row per program (read through `core/config.ts`, never trusted as typed). */
      programs: unknown;
      /** Seconds between two polls of one program. */
      pollInterval: number;
      /** Take completed downloads out of the object tree. */
      removeFinished: boolean;
    }

    /**
     * Custom notification scope for this adapter, declared in io-package.json `notifications`. Augmenting the
     * built-in `NotificationScopes` lets `registerNotification("download-manager", "userActionRequired", …)`
     * type-check without a cast. The single category surfaces user-actionable problems.
     */
    interface NotificationScopes {
      "download-manager": "userActionRequired";
    }
  }
}

// This file needs to be a module — see https://www.typescriptlang.org/docs/handbook/declaration-files/templates/global-modifying-module-d-ts.html
export {};
