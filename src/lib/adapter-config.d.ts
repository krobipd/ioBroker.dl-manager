// This file extends the AdapterConfig type from "@iobroker/types"

declare global {
  namespace ioBroker {
    interface AdapterConfig {
      /** One row per program, written by the device-manager dialog (read through `core/config.ts`, never trusted as typed). */
      programs: unknown;
      /** Seconds between two polls of one program. */
      pollInterval: number;
      /** Which downloads get a channel: `all`, `withoutCompleted` or `unfinished` (read through `core/config.ts`). */
      treeScope: string;
      /** At most this many download channels per program, 0 = all (read through `core/config.ts`). */
      maxDownloads: number;
    }

    /**
     * Custom notification scope for this adapter, declared in io-package.json `notifications`. Augmenting the
     * built-in `NotificationScopes` lets `registerNotification("dl-manager", "userActionRequired", …)`
     * type-check without a cast. The single category surfaces user-actionable problems.
     */
    interface NotificationScopes {
      "dl-manager": "userActionRequired";
    }
  }
}

// This file needs to be a module — see https://www.typescriptlang.org/docs/handbook/declaration-files/templates/global-modifying-module-d-ts.html
export {};
