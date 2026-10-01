import type { AdapterInstance } from "@iobroker/adapter-core";
import {
  ACTIONS,
  DeviceManagement,
  type ActionContext,
  type DeviceDetails,
  type DeviceInfo,
  type DeviceLoadContext,
  type InstanceDetails,
  type JsonFormSchema,
} from "@iobroker/dm-utils";
import { addressOf, blocksAddress, parsePrograms, sameProgram, type ProgramRow, programKey } from "./core/config";
import { deviceIdFor, idSourceOf } from "./core/device-id";
import type { TestResult } from "./core/manager";
import {
  applyRuleOf,
  dialogType,
  type DialogType,
  emptyForm,
  formFromData,
  formToRow,
  OFFERED,
  pickJdDeviceForm,
  pickProgramForm,
  programForm,
  programLabel,
  rowToForm,
  storedType,
  type JdChoice,
  type ProgramForm,
  type SettingsRow,
} from "./dm-forms";
import { errText } from "./err-text";
import { tName } from "./i18n";
import type { ProgramType } from "./programs/catalog";
import { findProgram } from "./programs/registry";

/** What the device manager needs from the adapter besides the plain ioBroker surface. */
export interface DmHost {
  /** The program rows (`store.ts`, secrets readable), read fresh. */
  readRows(): Promise<SettingsRow[]>;
  /**
   * Changes the program rows: `change` gets them read fresh, after every change before it, and returns the rows to store
   * and take over at once (the instance does not restart) — or undefined to store nothing.
   */
  updateRows(change: (rows: SettingsRow[]) => SettingsRow[] | undefined): Promise<void>;
  /** @returns whether this instance has an object with this id (below the namespace) */
  hasObject(relId: string): Promise<boolean>;
  /** @returns the value of an own state (id below the namespace), undefined when it has none */
  readState(relId: string): Promise<ioBroker.StateValue | undefined>;
  /** Asks the program of one row once. */
  test(row: SettingsRow): Promise<TestResult>;
  /** Logs into My.JDownloader and lists the account's JDownloader instances. */
  listJdDevices(email: string, password: string): Promise<JdChoice[]>;
  /** The pictogram of a program type, as a data URI. */
  icon(type: string): string | undefined;
  /** The name of the ioBroker host this instance runs on — part of a local program's device id. */
  iobHost(): string;
}

/**
 * @param path a Material icon path (24 × 24)
 * @returns it as a data URI drawn in `currentColor`, so it takes the indicator's colour in both themes
 */
const svg = (path: string): string =>
  `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="${path}"/></svg>`,
  ).toString("base64")}`;
/** Card glyphs. */
const GLYPH = {
  downloading: svg("M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"),
  active: svg("M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"),
  paused: svg("M6 19h4V5H6v14zm8-14v14h4V5h-4z"),
  freeSpace: svg(
    "M20 6H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-3 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4z",
  ),
  test: svg("M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"),
};

/**
 * The programs as cards of the ioBroker device manager: add, edit, delete, switch and test a program. Every change is
 * stored and taken over at once (`DmHost.updateRows`) — no restart, so each answer reaches the admin. The card shows the
 * program's state; it controls nothing (krobi: the admin needs no control).
 */
export class DlDeviceManagement extends DeviceManagement<AdapterInstance> {
  /**
   * @param adapter the adapter (message channel, log)
   * @param host what the manager asks of the adapter
   */
  public constructor(
    adapter: AdapterInstance,
    private readonly host: DmHost,
  ) {
    super(adapter);
  }

  /** @returns the add button above the cards and the label of the address line */
  protected getInstanceInfo(): InstanceDetails {
    return {
      apiVersion: "v3",
      identifierLabel: tName("dmAddress"),
      actions: [
        {
          id: "add",
          icon: "add",
          description: tName("dmAdd"),
          handler: ctx => this.guard(ctx, () => this.addProgram(ctx), { refresh: false }),
        },
      ],
    };
  }

  /**
   * One card per settings row, switched-off ones included.
   *
   * @param context the load context
   */
  protected async loadDevices(context: DeviceLoadContext<string>): Promise<void> {
    let rows: ProgramRow[];
    try {
      rows = parsePrograms(await this.host.readRows(), findProgram);
    } catch (err: unknown) {
      this.log.error(`device manager: could not read the programs (${errText(err)})`);
      return;
    }
    const seen = new Set<string>();
    for (const row of rows) {
      // a second row with the same device id shares its device — one card, the first row
      if (seen.has(row.id)) {
        continue;
      }
      seen.add(row.id);
      try {
        context.addDevice(await this.card(row));
      } catch (err: unknown) {
        this.log.error(`device manager: ${row.id} could not be shown (${errText(err)})`);
      }
    }
  }

  /**
   * @param row one settings row
   * @returns its card
   */
  private async card(row: ProgramRow): Promise<DeviceInfo<string>> {
    const id = row.id;
    const ns = this.adapter.namespace;
    const state = (dp: string): { stateId: string } => ({ stateId: `${ns}.${id}.${dp}` });
    const [pausable, hasFreeSpace, error] = await Promise.all([
      this.host.hasObject(`${id}.paused`),
      this.host.hasObject(`${id}.freeSpace`),
      this.host.readState(`${id}.error`),
    ]);
    // the admin draws a warning for every text — `Unknown` (nothing asked yet, switched off) is none; a row that
    // cannot run says what is wrong with it, its datapoint only says Unknown
    const problem =
      row.problem || (typeof error === "string" && error !== "" && error !== "Unknown" ? error : undefined);
    const label = programLabel(row.cfg.type) || row.cfg.type;
    const manufacturer =
      row.cfg.type === "jdownloader-cloud"
        ? tName("dmCloud", label)
        : row.cfg.type === "jdownloader"
          ? tName("dmLocal", label)
          : label;
    return {
      id,
      name: row.cfg.name || id,
      icon: this.host.icon(row.cfg.type),
      manufacturer,
      model: state("version"),
      identifier: addressOf(row.cfg),
      enabled: row.enabled,
      hasDetails: true,
      status: {
        connection: { ...state("online"), mapping: { true: "connected", false: "disconnected" } },
        ...(problem && row.enabled ? { warning: problem } : {}),
      },
      indicators: [
        {
          id: "downloading",
          icon: GLYPH.downloading,
          value: state("downloading"),
          text: state("downloadSpeed"),
          unit: "MB/s",
          colorOn: "primary",
          tooltip: tName("dmIndDownloading"),
          order: 10,
        },
        {
          id: "active",
          icon: GLYPH.active,
          value: state("active"),
          showValue: true,
          hideIfEmpty: false,
          tooltip: tName("dmIndActive"),
          order: 20,
        },
        ...(pausable
          ? [
              {
                id: "paused",
                icon: GLYPH.paused,
                value: state("paused"),
                colorOn: "warning" as const,
                tooltip: tName("dmIndPaused"),
                order: 30,
              },
            ]
          : []),
        ...(hasFreeSpace
          ? [
              {
                id: "freeSpace",
                icon: GLYPH.freeSpace,
                value: state("freeSpace"),
                showValue: true,
                unit: "GB",
                tooltip: tName("dmIndFreeSpace"),
                order: 40,
              },
            ]
          : []),
      ],
      actions: [
        {
          // the switch the admin draws for `enabled`
          id: ACTIONS.ENABLE_DISABLE,
          handler: (cardId, ctx) => this.guard(ctx, () => this.toggleEnabled(cardId), { refresh: "devices" as const }),
        },
        {
          id: "test",
          icon: GLYPH.test,
          description: tName("dmTest"),
          handler: (cardId, ctx) => this.guard(ctx, () => this.testProgram(cardId, ctx), { refresh: "none" as const }),
        },
        {
          id: "edit",
          icon: "edit",
          description: tName("dmEdit"),
          handler: (cardId, ctx) =>
            this.guard(ctx, () => this.editProgram(cardId, ctx), { refresh: "devices" as const }),
        },
        {
          id: "delete",
          icon: "delete",
          description: tName("dmDelete"),
          confirmation: tName("dmDeleteConfirm", row.cfg.name || id),
          handler: (cardId, ctx) =>
            this.guard<{ delete: string } | { refresh: "devices" }>(ctx, () => this.deleteProgram(cardId), {
              refresh: "devices",
            }),
        },
      ],
    };
  }

  /**
   * The card's details: where the program's objects are — the device id is the adapter's, the name only a label.
   *
   * @param id the card
   * @returns the details panel
   */
  protected async getDeviceDetails(id: string): Promise<DeviceDetails<string>> {
    // dm-utils sends no answer for a handler that throws — the details window would wait for ever
    let row: ProgramRow | undefined;
    try {
      row = parsePrograms(await this.host.readRows(), findProgram).find(r => r.id === id);
    } catch (err: unknown) {
      this.log.error(`device manager: the details of ${id} could not read the settings (${errText(err)})`);
    }
    const line = (text: ioBroker.StringOrTranslated): Record<string, unknown> => ({
      type: "staticText",
      text,
      newLine: true,
      sm: 12,
    });
    const items: Record<string, unknown> = { id: line(tName("dmDetailsId", `${this.adapter.namespace}.${id}`)) };
    if (row?.cfg.device) {
      items.device = line(tName("dmDetailsDevice", row.cfg.device));
    }
    return { id, schema: { type: "panel", items } as unknown as JsonFormSchema };
  }

  /**
   * Runs a user action; a failure reaches the user as a message instead of a progress bar that never ends.
   *
   * @param ctx the action context
   * @param run the action
   * @param fallback the answer when it failed
   * @returns what the action answered, or the fallback
   */
  private async guard<T>(ctx: ActionContext, run: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await run();
    } catch (err: unknown) {
      this.log.error(`device manager: ${errText(err)}`);
      try {
        await ctx.showMessage(tName("dmActionFailed", errText(err)));
      } catch {
        // the dialog is gone already — the log line carries it
      }
      return fallback;
    }
  }

  /**
   * „+“: choose the program, then its dialog.
   *
   * @param ctx the action context
   * @returns whether the cards reload
   */
  private async addProgram(ctx: ActionContext): Promise<{ refresh: boolean }> {
    const pick = await ctx.showForm(
      pickProgramForm(t => this.host.icon(t)),
      {
        title: tName("dmAdd"),
        data: { type: "" },
        applyDisabledRule: "!data.type",
      },
    );
    const type = OFFERED.find(p => p.type === pick?.type)?.type;
    if (!type) {
      return { refresh: false };
    }
    return { refresh: await this.programDialog(ctx, type) };
  }

  /**
   * @param cardId the card
   * @param ctx the action context
   * @returns what reloads
   */
  private async editProgram(cardId: string, ctx: ActionContext): Promise<{ refresh: "devices" | "none" }> {
    const row = (await this.host.readRows()).find(r => this.idOf(r) === cardId);
    const type = row ? dialogType(row) : undefined;
    if (!type) {
      return { refresh: "devices" };
    }
    return { refresh: (await this.programDialog(ctx, type, cardId)) ? "devices" : "none" };
  }

  /**
   * The program dialog, for a new row or the row of a card; My.JDownloader adds the step that chooses the
   * JDownloader of the account. Checks again what the dialog checked (a browser may skip it), then stores.
   *
   * @param ctx the action context
   * @param type the dialog's program
   * @param cardId the card being edited, none for a new row
   * @returns whether the rows were stored
   */
  private async programDialog(ctx: ActionContext, type: DialogType, cardId?: string): Promise<boolean> {
    const rows = await this.host.readRows();
    const index = cardId === undefined ? -1 : rows.findIndex(r => this.idOf(r) === cardId);
    const previous = index >= 0 ? rows[index] : undefined;
    const parsed = parsePrograms(
      rows.filter((_, i) => i !== index),
      findProgram,
    );
    const opened: ProgramForm = previous
      ? rowToForm(previous)
      : { ...emptyForm(type), name: this.suggestedName(type, rows) };
    const schema = programForm(type, {
      takenKeys: parsed.filter(r => blocksAddress(r) && r.cfg.host).map(r => programKey(r.cfg)),
    });
    const answer = await ctx.showForm(schema, {
      title: tName(previous ? "dmEditTitle" : "dmAddTitle", previous ? opened.name : programLabel(type)),
      data: { ...opened },
      maxWidth: "md",
      applyDisabledRule: applyRuleOf(schema),
    });
    if (!answer) {
      return false;
    }
    const form = formFromData(answer, opened);
    let device: JdChoice | undefined;
    if (storedType(type, form) === "jdownloader-cloud") {
      device = await this.pickJdDevice(ctx, form, parsed, previous);
      if (device === undefined) {
        return false;
      }
    }
    // the dialog waited for the user: what it stores goes onto the rows as they are now, never onto the ones it opened with
    const outcome: { changed: boolean; twin?: ProgramRow } = { changed: false };
    await this.host.updateRows(now => {
      const at = cardId === undefined ? -1 : now.findIndex(r => this.idOf(r) === cardId);
      if (cardId !== undefined && at < 0) {
        outcome.changed = true;
        return undefined;
      }
      const others = parsePrograms(
        now.filter((_, i) => i !== at),
        findProgram,
      );
      // an edited row keeps its id; a new one gets it from the machine or the My.JDownloader instance
      const id =
        (at >= 0 && this.idOf(now[at])) ||
        deviceIdFor(
          idSourceOf(formToRow(type, form, "", {}, device)),
          new Set(others.map(r => r.id)),
          this.host.iobHost(),
        ) ||
        "";
      const row = formToRow(type, form, id, at >= 0 ? now[at] : undefined, device);
      const [candidate] = parsePrograms([row], findProgram);
      outcome.twin = candidate.enabled
        ? others.find(o => blocksAddress(o) && sameProgram(o.cfg, candidate.cfg))
        : undefined;
      if (outcome.twin) {
        return undefined;
      }
      const next = [...now];
      if (at >= 0) {
        next[at] = row;
      } else {
        next.push(row);
      }
      return next;
    });
    if (outcome.changed) {
      await ctx.showMessage(tName("dmChanged"));
      return true;
    }
    if (outcome.twin) {
      await ctx.showMessage(
        tName("dmDuplicate", outcome.twin.cfg.name || outcome.twin.id, addressOf(outcome.twin.cfg)),
      );
      return false;
    }
    return true;
  }

  /**
   * The My.JDownloader step: log in, offer the account's JDownloader instances no other row asks yet.
   *
   * @param ctx the action context
   * @param form the dialog data (e-mail, password)
   * @param others the other rows
   * @param previous the row being edited, if any
   * @returns the chosen instance, undefined when the user stopped or nothing can be chosen
   */
  private async pickJdDevice(
    ctx: ActionContext,
    form: ProgramForm,
    others: readonly ProgramRow[],
    previous: SettingsRow | undefined,
  ): Promise<JdChoice | undefined> {
    const email = form.username.trim();
    const progress = await ctx.openProgress(tName("dmLoggingIn", email), { indeterminate: true });
    let devices: JdChoice[];
    try {
      devices = await this.host.listJdDevices(email, form.password);
    } catch (err: unknown) {
      await progress.close();
      await ctx.showMessage(tName("dmLoginFailed", errText(err)));
      return undefined;
    }
    await progress.close();
    const mine = others.filter(
      r =>
        blocksAddress(r) && r.cfg.type === "jdownloader-cloud" && r.cfg.username.toLowerCase() === email.toLowerCase(),
    );
    // an instance another enabled row asks is taken — by its id, or by its name for a row that has no id yet
    const free = devices.filter(
      d => !mine.some(r => (r.cfg.deviceId ? r.cfg.deviceId === d.id : r.cfg.device === d.name)),
    );
    if (!free.length) {
      await ctx.showMessage(tName("dmNoDevices"));
      return undefined;
    }
    const current = free.find(d => d.id === previous?.deviceId || d.name === previous?.device)?.id ?? "";
    const answer = await ctx.showForm(pickJdDeviceForm(free), {
      title: tName("dmPickDeviceTitle"),
      data: { device: current || (free.length === 1 ? free[0].id : "") },
      applyDisabledRule: "!data.device",
    });
    return free.find(d => d.id === answer?.device);
  }

  /**
   * Deletes the row of a card, and with it the program's device. The admin asked before the handler runs.
   *
   * @param cardId the card
   * @returns the card to remove
   */
  private async deleteProgram(cardId: string): Promise<{ delete: string }> {
    await this.host.updateRows(rows => {
      const next = rows.filter(r => this.idOf(r) !== cardId);
      return next.length !== rows.length ? next : undefined;
    });
    return { delete: cardId };
  }

  /**
   * The card's on/off switch: the program is asked or not — its device stays either way.
   *
   * @param cardId the card
   * @returns the cards reload
   */
  private async toggleEnabled(cardId: string): Promise<{ refresh: "devices" }> {
    await this.host.updateRows(rows => {
      const index = rows.findIndex(r => this.idOf(r) === cardId);
      if (index < 0) {
        return undefined;
      }
      const next = [...rows];
      next[index] = { ...rows[index], enabled: rows[index].enabled === false };
      return next;
    });
    return { refresh: "devices" };
  }

  /**
   * The card's connection test: the stored row, asked once, the answer as a message.
   *
   * @param cardId the card
   * @param ctx the action context
   * @returns nothing reloads
   */
  private async testProgram(cardId: string, ctx: ActionContext): Promise<{ refresh: "none" }> {
    const row = (await this.host.readRows()).find(r => this.idOf(r) === cardId);
    if (!row) {
      return { refresh: "none" };
    }
    const name = typeof row.name === "string" && row.name ? row.name : cardId;
    const progress = await ctx.openProgress(tName("dmTesting", name), { indeterminate: true });
    let result: TestResult;
    try {
      result = await this.host.test(row);
    } finally {
      await progress.close();
    }
    await ctx.showMessage(testText(name, result));
    return { refresh: "none" };
  }

  /**
   * @param row a stored row
   * @returns its device id (= card id) — the one the card was built with
   */
  private idOf(row: SettingsRow): string {
    return parsePrograms([row], findProgram)[0]?.id ?? "";
  }

  /**
   * @param type the dialog's program
   * @param rows all rows
   * @returns the product name, numbered from the second row of the same program on
   */
  private suggestedName(type: ProgramType, rows: readonly SettingsRow[]): string {
    const label = type === "jdownloader" ? "JDownloader" : programLabel(type);
    const count = rows.filter(r => dialogType(r) === type).length;
    return count ? `${label} ${count + 1}` : label;
  }
}

/**
 * @param name the program's name
 * @param result what the test found
 * @returns the message for the user
 */
export function testText(name: string, result: TestResult): ioBroker.StringOrTranslated {
  if (result.ok) {
    return result.downloads === undefined
      ? tName("dmTestOk", name, result.version)
      : tName("dmTestOkDownloads", name, result.version, result.downloads);
  }
  switch (result.kind) {
    case "auth":
      return tName("dmTestAuth", name, result.text);
    case "unreachable":
      return tName("dmTestUnreachable", name, result.text);
    default:
      return tName("dmTestOther", name, result.text);
  }
}
