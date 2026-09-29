import type { AdapterInstance } from "@iobroker/adapter-core";
import {
  ACTIONS,
  DeviceManagement,
  type ActionContext,
  type DeviceInfo,
  type DeviceLoadContext,
  type InstanceDetails,
} from "@iobroker/dm-utils";
import { addressOf, parsePrograms, sameProgram, type ProgramRow, programKey } from "./core/config";
import { programId } from "./core/ids";
import type { TestResult } from "./core/manager";
import {
  applyRuleOf,
  deriveKey,
  dialogType,
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
  textOf,
  type ProgramForm,
  type SettingsRow,
} from "./dm-forms";
import { errText } from "./err-text";
import { tName } from "./i18n";
import type { ProgramType } from "./programs/catalog";
import { findProgram } from "./programs/registry";

/** What the device manager needs from the adapter besides the plain ioBroker surface. */
export interface DmHost {
  /** The stored settings rows (`native.programs` of the instance object), read fresh. */
  readRows(): Promise<SettingsRow[]>;
  /** Stores the settings rows — the instance restarts with them. */
  writeRows(rows: SettingsRow[]): Promise<void>;
  /** @returns whether this instance has an object with this id (below the namespace) */
  hasObject(relId: string): Promise<boolean>;
  /** @returns the value of an own state (id below the namespace), undefined when it has none */
  readState(relId: string): Promise<ioBroker.StateValue | undefined>;
  /** Writes a state the way a user does (`ack: false`) — the adapter's command path takes it from there. */
  writeState(relId: string, val: ioBroker.StateValue): Promise<void>;
  /** Asks the program of one settings row once. */
  test(row: SettingsRow): Promise<TestResult>;
  /** Logs into My.JDownloader and names the account's JDownloader instances. */
  listJdDevices(email: string, password: string): Promise<string[]>;
  /** The pictogram of a program type, as a data URI. */
  icon(type: string): string | undefined;
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
 * The programs as cards of the ioBroker device manager: add, edit, delete and test a program, pause it from its card.
 * The settings rows stay the one store (`native.programs`); every change writes them, and the instance restarts.
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
      rows = parsePrograms(await this.host.readRows(), v => v, findProgram);
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
    // the admin draws a warning for every text — `Unknown` (nothing asked yet, switched off) is none
    const problem = typeof error === "string" && error !== "" && error !== "Unknown" ? error : undefined;
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
      controls: pausable
        ? [
            {
              id: "paused",
              type: "switch",
              stateId: `${ns}.${id}.paused`,
              label: tName("dmPauseAll"),
              handler: async (_device, _control, value) => {
                const on = value === true;
                try {
                  await this.host.writeState(`${id}.paused`, on);
                } catch (err: unknown) {
                  this.log.error(`device manager: ${id} could not be paused (${errText(err)})`);
                  return { error: { code: 500, message: errText(err) } };
                }
                return { val: on, ack: false, ts: Date.now(), lc: Date.now(), from: `system.adapter.${ns}` };
              },
            },
          ]
        : [],
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
          // the admin asks before the handler runs — no message round trip across the restart the write causes
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
  private async programDialog(ctx: ActionContext, type: ProgramType, cardId?: string): Promise<boolean> {
    const rows = await this.host.readRows();
    const index = cardId === undefined ? -1 : rows.findIndex(r => this.idOf(r) === cardId);
    const previous = index >= 0 ? rows[index] : undefined;
    const others = rows.filter((_, i) => i !== index);
    const parsed = parsePrograms(others, v => v, findProgram);
    const opened: ProgramForm = previous
      ? rowToForm(previous)
      : { ...emptyForm(type), name: this.suggestedName(type, rows) };
    const schema = programForm(type, {
      takenKeys: parsed.filter(r => r.cfg.host).map(r => programKey(r.cfg)),
      takenIds: parsed.map(r => r.id),
      editing: previous !== undefined,
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
    const stored = storedType(type, form);
    const takenIds = new Set(parsed.map(r => r.id));
    const key = previous ? textOf(previous.key) : form.key.trim() || deriveKey(stored, form.name, takenIds);
    let device = "";
    if (stored === "jdownloader-cloud") {
      const chosen = await this.pickJdDevice(ctx, form, parsed, previous);
      if (chosen === undefined) {
        return false;
      }
      device = chosen;
    }
    const row = formToRow(type, form, key, previous, device);
    const [candidate] = parsePrograms([row], v => v, findProgram);
    if (takenIds.has(candidate.id)) {
      await ctx.showMessage(tName("dmIdTaken", candidate.id));
      return false;
    }
    const twin = parsed.find(o => o.enabled && !o.problem && sameProgram(o.cfg, candidate.cfg));
    if (twin && candidate.enabled) {
      await ctx.showMessage(tName("dmDuplicate", twin.cfg.name || twin.id, addressOf(twin.cfg)));
      return false;
    }
    const next = [...rows];
    if (index >= 0) {
      next[index] = row;
    } else {
      next.push(row);
    }
    await this.host.writeRows(next);
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
  ): Promise<string | undefined> {
    const email = form.username.trim();
    const progress = await ctx.openProgress(tName("dmLoggingIn", email), { indeterminate: true });
    let names: string[];
    try {
      names = await this.host.listJdDevices(email, form.password);
    } catch (err: unknown) {
      await progress.close();
      await ctx.showMessage(tName("dmLoginFailed", errText(err)));
      return undefined;
    }
    await progress.close();
    const taken = new Set(
      others
        .filter(r => r.cfg.type === "jdownloader-cloud" && r.cfg.username.toLowerCase() === email.toLowerCase())
        .map(r => r.cfg.device),
    );
    const free = names.filter(n => !taken.has(n));
    if (!free.length) {
      await ctx.showMessage(tName("dmNoDevices"));
      return undefined;
    }
    const current = typeof previous?.device === "string" && free.includes(previous.device) ? previous.device : "";
    const answer = await ctx.showForm(pickJdDeviceForm(free), {
      title: tName("dmPickDeviceTitle"),
      data: { device: current || (free.length === 1 ? free[0] : "") },
      applyDisabledRule: "!data.device",
    });
    const device = answer?.device;
    return typeof device === "string" && free.includes(device) ? device : undefined;
  }

  /**
   * Deletes the row of a card. The admin confirmed before; the answer leaves before the write, which restarts the
   * instance — a handler that waits for it never answers.
   *
   * @param cardId the card
   * @returns the card to remove
   */
  private async deleteProgram(cardId: string): Promise<{ delete: string }> {
    const rows = await this.host.readRows();
    const next = rows.filter(r => this.idOf(r) !== cardId);
    if (next.length !== rows.length) {
      this.adapter.setTimeout(() => {
        this.host
          .writeRows(next)
          .catch((err: unknown) =>
            this.log.error(`could not delete the program ${cardId} from the settings (${errText(err)})`),
          );
      }, 0);
    }
    return { delete: cardId };
  }

  /**
   * The card's on/off switch: the program is asked or not — its device stays either way.
   *
   * @param cardId the card
   * @returns the cards reload
   */
  private async toggleEnabled(cardId: string): Promise<{ refresh: "devices" }> {
    const rows = await this.host.readRows();
    const index = rows.findIndex(r => this.idOf(r) === cardId);
    if (index >= 0) {
      rows[index] = { ...rows[index], enabled: rows[index].enabled === false };
      await this.host.writeRows(rows);
    }
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
   * @returns its device id (= card id)
   */
  private idOf(row: SettingsRow): string {
    return programId(textOf(row.type), textOf(row.key));
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
