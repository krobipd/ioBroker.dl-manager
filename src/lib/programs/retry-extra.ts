import type { ExtraDefinition } from "../core/model";

/**
 * The button that downloads a failed job again — both Usenet programs have it (SABnzbd `retry`, NZBGet
 * `HistoryRedownload`); what it sends stays with each driver.
 */
export const RETRY_EXTRA: ExtraDefinition = {
  id: "retry",
  level: "item",
  type: "boolean",
  role: "button",
  write: true,
  read: false,
  nameKey: "retry",
  descKey: "descRetry",
};
