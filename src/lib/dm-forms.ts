import type { JsonFormSchema } from "@iobroker/dm-utils";
import { tName, tText, type I18nKey } from "./i18n";
import { CATALOG, catalogEntry, type ProgramInfo, type ProgramType } from "./programs/catalog";

/**
 * The settings dialogs of the device manager, and the conversion between a program row (`store.ts`) and the data a
 * dialog edits. Pure: no adapter, no I/O.
 */

/** One program row with readable secrets — fields the dialog does not know are kept. */
export type SettingsRow = Record<string, unknown>;

/** A JDownloader instance of a My.JDownloader account, as the dialog stores it. */
export interface JdChoice {
  /** The account's id for it. */
  id: string;
  /** Its name. */
  name: string;
}

/** What a program dialog edits. Field names follow the settings row where there is one. */
export interface ProgramForm {
  /** Display name of the card and the device. */
  name: string;
  /** JDownloader only: `local` or `cloud` (My.JDownloader). */
  mode: "local" | "cloud";
  /** Host name or IP address. */
  host: string;
  /** Port as typed, "" = the program's default. */
  port: string;
  /** qBittorrent / pyLoad: log in with `user` and password or with an API `key`. */
  login: "user" | "key";
  /** Transmission: the program asks for a login. */
  needLogin: boolean;
  /** User, or the e-mail of a My.JDownloader account. */
  username: string;
  /** Password. */
  password: string;
  /** API key or RPC secret. */
  apiKey: string;
  /** Show HTTPS and path. */
  advanced: boolean;
  /** TLS. */
  https: boolean;
  /** Path below the host, "" = the program's default. */
  path: string;
  /** The program is asked. */
  enabled: boolean;
}

/** The program types a dialog is for — My.JDownloader is a mode of the JDownloader dialog. */
export type DialogType = Exclude<ProgramType, "jdownloader-cloud">;

/** A program a dialog is offered for. */
type Offered = ProgramInfo & { type: DialogType };

/** The program types the dialog offers — My.JDownloader is a switch inside the JDownloader dialog. */
export const OFFERED: readonly Offered[] = CATALOG.filter((p): p is Offered => p.type !== "jdownloader-cloud");

/** Per program: the hint the dialog shows under its fields. */
const HINT: Readonly<Record<ProgramType, I18nKey>> = {
  jdownloader: "hint_jdownloader",
  "jdownloader-cloud": "hint_jdownloaderCloud",
  qbittorrent: "hint_qbittorrent",
  transmission: "hint_transmission",
  deluge: "hint_deluge",
  sabnzbd: "hint_sabnzbd",
  nzbget: "hint_nzbget",
  aria2: "hint_aria2",
  pyload: "hint_pyload",
};

/**
 * @param v a value from a stored row or a dialog answer
 * @returns it as text — a string as it is, a number written out, anything else ""
 */
export const textOf = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/**
 * @param row a stored settings row
 * @returns the program type the dialog shows for it (both JDownloader connections share one dialog), undefined for a
 *   type the adapter does not know
 */
export function dialogType(row: SettingsRow): DialogType | undefined {
  return row.type === "jdownloader-cloud" ? "jdownloader" : OFFERED.find(p => p.type === row.type)?.type;
}

/**
 * @param row a stored settings row
 * @returns the dialog data for editing it
 */
export function rowToForm(row: SettingsRow): ProgramForm {
  const https = row.https === true;
  const path = textOf(row.path);
  const apiKey = textOf(row.apiKey);
  const username = textOf(row.username);
  const port = typeof row.port === "number" && row.port > 0 ? String(row.port) : "";
  return {
    name: textOf(row.name),
    mode: row.type === "jdownloader-cloud" ? "cloud" : "local",
    host: textOf(row.host),
    port,
    // what the program logs in with today: both clients take a stored API key first
    login: apiKey || (row.type === "pyload" && !username) ? "key" : "user",
    needLogin: username !== "",
    username,
    password: textOf(row.password),
    apiKey,
    advanced: https || path !== "",
    https,
    path,
    enabled: row.enabled !== false,
  };
}

/**
 * @param type the dialog's program
 * @returns the data of an empty dialog
 */
export function emptyForm(type: ProgramType): ProgramForm {
  return {
    name: "",
    mode: "local",
    host: "",
    port: "",
    login: catalogEntry(type).login === "keyOrUser" ? "key" : "user",
    needLogin: false,
    username: "",
    password: "",
    apiKey: "",
    advanced: false,
    https: false,
    path: "",
    enabled: true,
  };
}

/**
 * What a dialog answered, typed — a field the answer lacks or carries in another type keeps the value the dialog
 * was opened with (API boundary: the answer comes from the browser).
 *
 * @param data the dialog's answer
 * @param opened the data the dialog was opened with
 * @returns the dialog data
 */
export function formFromData(data: Record<string, unknown>, opened: ProgramForm): ProgramForm {
  const text = (k: keyof ProgramForm): string => {
    const v = data[k];
    return typeof v === "string" ? v : typeof v === "number" ? String(v) : String(opened[k]);
  };
  const flag = (k: keyof ProgramForm): boolean => (typeof data[k] === "boolean" ? data[k] : (opened[k] as boolean));
  return {
    name: text("name"),
    mode: data.mode === "cloud" || data.mode === "local" ? data.mode : opened.mode,
    host: text("host"),
    port: text("port"),
    login: data.login === "key" || data.login === "user" ? data.login : opened.login,
    needLogin: flag("needLogin"),
    username: text("username"),
    password: text("password"),
    apiKey: text("apiKey"),
    advanced: flag("advanced"),
    https: flag("https"),
    path: text("path"),
    enabled: flag("enabled"),
  };
}

/**
 * @param type the dialog's program
 * @param form what the dialog returned
 * @returns the program type the row is stored with (the JDownloader switch picks the connection)
 */
export function storedType(type: ProgramType, form: Pick<ProgramForm, "mode">): ProgramType {
  return type === "jdownloader" && form.mode === "cloud" ? "jdownloader-cloud" : type;
}

/**
 * The settings row a dialog produces. Everything the dialog does not show survives from the previous row, and the
 * fields the chosen login does not use are emptied — a program never keeps a password it no longer logs in with.
 *
 * @param type the dialog's program
 * @param form what the dialog returned
 * @param id the device id, already decided (`device-id.ts`) — an edited row keeps its own
 * @param previous the row being edited, if any
 * @param device My.JDownloader: the chosen JDownloader of the account
 * @returns the row to store
 */
export function formToRow(
  type: ProgramType,
  form: ProgramForm,
  id: string,
  previous: SettingsRow = {},
  device?: JdChoice,
): SettingsRow {
  const stored = storedType(type, form);
  const login = catalogEntry(stored).login;
  const port = Number(form.port);
  const row: SettingsRow = {
    ...previous,
    id,
    enabled: form.enabled,
    type: stored,
    name: form.name.trim(),
    host: "",
    port: 0,
    https: false,
    path: "",
    username: "",
    password: "",
    apiKey: "",
    device: "",
    deviceId: "",
  };
  if (login === "account") {
    return {
      ...row,
      username: form.username.trim(),
      password: form.password,
      device: device?.name ?? "",
      deviceId: device?.id ?? "",
    };
  }
  Object.assign(row, {
    host: form.host.trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
    https: form.https,
    path: form.path.trim(),
  });
  const user = { username: form.username.trim(), password: form.password };
  switch (login) {
    case "password":
      return { ...row, password: form.password };
    case "apiKey":
    case "secret":
      return { ...row, apiKey: form.apiKey.trim() };
    case "user":
      return { ...row, ...user };
    case "optionalUser":
      return form.needLogin ? { ...row, ...user } : row;
    case "userOrKey":
    case "keyOrUser":
      return form.login === "key" ? { ...row, apiKey: form.apiKey.trim() } : { ...row, ...user };
    default:
      return row;
  }
}

/**
 * @param type a program type
 * @returns its product name ("" for an unknown type)
 */
export function programLabel(type: string): string {
  return CATALOG.find(p => p.type === type)?.label ?? "";
}

/**
 * The first dialog: which program to add.
 *
 * @param icon the pictogram of a program type
 * @returns the schema
 */
export function pickProgramForm(icon: (type: string) => string | undefined): JsonFormSchema {
  return {
    type: "panel",
    items: {
      type: {
        type: "select",
        format: "radio",
        label: tName("dmPickHelp"),
        options: OFFERED.map(p => ({ value: p.type, label: p.label, icon: icon(p.type) })),
        sm: 12,
      },
    },
  } as unknown as JsonFormSchema;
}

/**
 * A value as a literal inside a dialog expression. json-config runs an expression that contains the word `return` as a
 * function body and adds no `return` of its own (`execute`: `c.includes('return') ? c : 'return ' + c`) — it then yields
 * `undefined`. So no expression spells the word, not even inside a host name or an ID it carries.
 *
 * @param value a JSON value
 * @returns its JavaScript literal
 */
function literal(value: unknown): string {
  return JSON.stringify(value).replace(/return/g, "\\u0072eturn");
}

/**
 * The expression the dialog runs to build a row's {@link programKey} from its data — kept in step with `programKey` by
 * a test that runs both on the same rows.
 *
 * @param info the local program's defaults
 * @returns a JavaScript expression over `data`
 */
export function programKeyExpression(info: Pick<ProgramInfo, "port" | "path">): string {
  return (
    `String(data.host||'').trim().toLowerCase()+':'+(Number(data.port)>0?Number(data.port):${info.port})` +
    `+[String(data.path||'').trim().replace(/\\/+$/,'')||${literal(info.path)}]` +
    `.map(p=>(p&&p.charAt(0)!=='/'?'/'+p:p).toLowerCase())[0]`
  );
}

/** What the program dialog needs to know about the other rows. */
export interface FormContext {
  /** `programKey` of every other row. */
  takenKeys: readonly string[];
}

/**
 * A field check: the field holds more than blanks, unless the field is hidden.
 *
 * @param hidden the field's `hidden` expression
 * @param field the field in the dialog data, e.g. `data.name`
 * @returns the validator expression
 */
const requiredUnless = (hidden: string, field: string): string => `(${hidden}) || !!String(${field}||'').trim()`;

/**
 * The program dialog: only the fields of this program.
 *
 * @param type the dialog's program
 * @param ctx the other rows
 * @returns the schema
 */
export function programForm(type: DialogType, ctx: FormContext): JsonFormSchema {
  const info = catalogEntry(type);
  const jd = type === "jdownloader";
  const cloud = "data.mode==='cloud'";
  const local = jd ? `data.mode!=='cloud'` : "true";
  const items: Record<string, unknown> = {};
  if (jd) {
    items.mode = {
      type: "select",
      format: "radio",
      horizontal: true,
      label: tName("dmJdMode"),
      options: [
        { value: "local", label: tText("dmJdLocal") },
        { value: "cloud", label: tText("dmJdCloud") },
      ],
      sm: 12,
    };
  }
  items.name = {
    type: "text",
    label: tName("dmName"),
    help: tName("dmNameHelp"),
    validator: requiredUnless("false", "data.name"),
    newLine: true,
    sm: 12,
    md: 6,
  };
  // a switched-off entry asks nothing, so its address is free for it (decision 15)
  const taken = `(data.enabled !== false && ${literal(ctx.takenKeys)}.includes(${programKeyExpression(info)}))`;
  items.host = {
    type: "text",
    label: tName("dmHost"),
    hidden: `!(${local})`,
    validator: `!(${local}) || (/^[^\\s/]+$/.test(String(data.host||'').trim()) && !${taken})`,
    newLine: true,
    sm: 12,
    md: 6,
  };
  items.port = {
    type: "text",
    label: tName("dmPort"),
    placeholder: String(info.port),
    help: tName("dmDefault", info.port),
    hidden: `!(${local})`,
    validator: `!(${local}) || !String(data.port||'').trim() || (/^\\d+$/.test(String(data.port).trim()) && Number(data.port) > 0 && Number(data.port) < 65536)`,
    sm: 12,
    md: 6,
  };
  if (jd) {
    items.username = {
      type: "text",
      label: tName("dmEmail"),
      hidden: `!(${cloud})`,
      validator: `!(${cloud}) || /^\\S+@\\S+\\.\\S+$/.test(String(data.username||'').trim())`,
      newLine: true,
      sm: 12,
      md: 6,
    };
    items.password = {
      type: "password",
      label: tName("dmPassword"),
      hidden: `!(${cloud})`,
      validator: requiredUnless(`!(${cloud})`, "data.password"),
      sm: 12,
      md: 6,
    };
  }
  Object.assign(items, loginItems(info));
  items.advanced = { type: "checkbox", label: tName("dmAdvanced"), newLine: true, sm: 12 };
  items.https = {
    type: "checkbox",
    label: tName(type === "aria2" ? "dmWss" : "dmHttps"),
    hidden: `!data.advanced || !(${local})`,
    newLine: true,
    sm: 12,
    md: 4,
  };
  items.path = {
    type: "text",
    label: tName("dmPath"),
    placeholder: info.path || "/",
    help: info.path ? tName("dmDefault", info.path) : tName("dmPathHelp"),
    hidden: `!data.advanced || !(${local})`,
    sm: 12,
    md: 4,
  };
  items.enabled = { type: "checkbox", label: tName("dmEnabled"), newLine: true, sm: 12 };
  // the field's own error text is not shown in a device-manager dialog — say it where it is read
  items.taken = {
    type: "infoBox",
    boxType: "warning",
    closeable: false,
    text: tName("dmHostTaken"),
    hidden: `!(${local}) || !${taken}`,
    newLine: true,
    sm: 12,
  };
  items.hint = {
    type: "infoBox",
    boxType: "info",
    closeable: false,
    text: tName(HINT[type]),
    hidden: jd ? cloud : "false",
    newLine: true,
    sm: 12,
  };
  if (jd) {
    items.hintCloud = {
      type: "infoBox",
      boxType: "info",
      closeable: false,
      text: tName(HINT["jdownloader-cloud"]),
      hidden: `!(${cloud})`,
      newLine: true,
      sm: 12,
    };
  }
  return { type: "panel", items } as unknown as JsonFormSchema;
}

/**
 * @param info the program
 * @returns the login fields the program has (none for JDownloader: its account fields sit above)
 */
function loginItems(info: ProgramInfo): Record<string, unknown> {
  const user = (hidden: string, userRequired: boolean): Record<string, unknown> => ({
    username: {
      type: "text",
      label: tName("dmUser"),
      hidden,
      ...(userRequired
        ? {
            validator: requiredUnless(hidden, "data.username"),
          }
        : {}),
      newLine: true,
      sm: 12,
      md: 6,
    },
    password: { type: "password", label: tName("dmPassword"), hidden, sm: 12, md: 6 },
  });
  const key = (label: I18nKey, hidden: string, isRequired: boolean, help?: I18nKey): Record<string, unknown> => ({
    apiKey: {
      type: "password",
      label: tName(label),
      hidden,
      ...(help ? { help: tName(help) } : {}),
      ...(isRequired
        ? {
            validator: requiredUnless(hidden, "data.apiKey"),
          }
        : {}),
      newLine: true,
      sm: 12,
      md: 6,
    },
  });
  const choice = (): Record<string, unknown> => ({
    login: {
      type: "select",
      format: "radio",
      horizontal: true,
      label: tName("dmLogin"),
      options: [
        { value: "user", label: tText("dmLoginUser") },
        { value: "key", label: tText("dmLoginKey") },
      ],
      newLine: true,
      sm: 12,
    },
    ...user("data.login!=='user'", false),
    ...key("dmApiKey", "data.login!=='key'", true),
  });
  switch (info.login) {
    case "password":
      return {
        password: {
          type: "password",
          label: tName("dmWebPassword"),
          validator: "!!String(data.password||'')",
          newLine: true,
          sm: 12,
          md: 6,
        },
      };
    case "apiKey":
      return key("dmApiKey", "false", true);
    case "secret":
      return key("dmSecret", "false", false, "dmSecretHelp");
    case "user":
      return user("false", false);
    case "optionalUser":
      return {
        needLogin: { type: "checkbox", label: tName("dmNeedLogin"), newLine: true, sm: 12 },
        ...user("!data.needLogin", true),
      };
    case "userOrKey":
    case "keyOrUser":
      return choice();
    default:
      return {};
  }
}

/**
 * A device-manager dialog does not hold its OK button for a failing field check (`validatorNoSaveOnError` is a
 * settings-page feature) — this rule does: OK stays off until every visible field passes. The field checks already
 * pass for a hidden field, so the rule is simply all of them.
 *
 * @param schema a dialog schema
 * @returns the dialog's `applyDisabledRule`
 */
export function applyRuleOf(schema: JsonFormSchema): string {
  const checks = Object.values((schema as unknown as { items: Record<string, { validator?: unknown }> }).items)
    .map(i => i.validator)
    .filter((v): v is string => typeof v === "string");
  return checks.length ? `!(${checks.map(v => `(${v})`).join(" && ")})` : "false";
}

/**
 * The My.JDownloader step: which JDownloader of the account this entry asks.
 *
 * @param devices the account's JDownloader instances not set up yet
 * @returns the schema
 */
export function pickJdDeviceForm(devices: readonly JdChoice[]): JsonFormSchema {
  return {
    type: "panel",
    items: {
      device: {
        type: "select",
        format: "radio",
        label: tName("dmPickDeviceHelp"),
        options: devices.map(d => ({ value: d.id, label: d.name })),
        sm: 12,
      },
    },
  } as unknown as JsonFormSchema;
}
