import { ProtocolError } from "../../core/errors";

/*
 * XML-RPC as rTorrent speaks it (http://xmlrpc.com/spec.md, plus the `i8` extension of xmlrpc-c and of 0.16's own
 * tinyxml2 parser): only what one call and its answer need. A document that is no complete `methodResponse` is refused
 * whole (decision 28) — a cut answer must never read as an empty torrent list.
 */

/** An XML-RPC value the driver sends. */
export type RpcParam = string | number | boolean | readonly RpcParam[] | { readonly [key: string]: RpcParam };

/**
 * @param s text
 * @returns escaped for an XML text node
 */
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * @param v a parameter
 * @returns its `<value>` element
 */
function encode(v: RpcParam): string {
  if (typeof v === "number") {
    const n = Math.trunc(v);
    return Math.abs(n) < 2 ** 31 ? `<value><i4>${n}</i4></value>` : `<value><i8>${n}</i8></value>`;
  }
  if (typeof v === "boolean") {
    return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  }
  if (typeof v === "string") {
    return `<value><string>${esc(v)}</string></value>`;
  }
  if (Array.isArray(v)) {
    return `<value><array><data>${v.map(encode).join("")}</data></array></value>`;
  }
  const members = Object.entries(v as Record<string, RpcParam>).map(
    ([k, m]) => `<member><name>${esc(k)}</name>${encode(m)}</member>`,
  );
  return `<value><struct>${members.join("")}</struct></value>`;
}

/**
 * @param method the method name
 * @param params its parameters
 * @returns the request document
 */
export function methodCall(method: string, params: readonly RpcParam[]): string {
  return `<?xml version="1.0"?><methodCall><methodName>${esc(method)}</methodName><params>${params
    .map(p => `<param>${encode(p)}</param>`)
    .join("")}</params></methodCall>`;
}

/** One element of the parsed document. */
interface Node {
  name: string;
  children: Node[];
  text: string;
}

const ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/**
 * @param s an XML text node
 * @returns its text with the entities resolved
 */
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") {
      return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    }
    return ENTITIES[e.toLowerCase()];
  });
}

/**
 * @param text the answer
 * @returns its element tree under a root; an element left open refuses the document
 */
function tree(text: string): Node {
  const root: Node = { name: "#root", children: [], text: "" };
  const stack = [root];
  for (const m of text.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<(\/?)([\w.:-]+)[^>]*?(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[3]) {
      if (m[2]) {
        if (top.name !== m[3]) {
          throw new ProtocolError(`rTorrent's answer closes <${m[3]}> inside <${top.name}> — answer refused`);
        }
        stack.pop();
      } else {
        const node: Node = { name: m[3], children: [], text: "" };
        top.children.push(node);
        if (!m[4]) {
          stack.push(node);
        }
      }
    } else if (m[5] !== undefined) {
      top.text += decode(m[5]);
    }
  }
  if (stack.length !== 1) {
    throw new ProtocolError("rTorrent's answer ends inside an element — answer refused");
  }
  return root;
}

const child = (n: Node | undefined, name: string): Node | undefined => n?.children.find(c => c.name === name);

/**
 * @param v a `<value>` element
 * @returns its content — numbers as numbers, an untyped value as text
 */
function valueOf(v: Node | undefined): unknown {
  if (!v || v.name !== "value") {
    throw new ProtocolError("rTorrent's answer holds no value where one belongs — answer refused");
  }
  const t = v.children[0];
  if (!t) {
    return v.text;
  }
  switch (t.name) {
    case "i4":
    case "i8":
    case "int":
    case "double": {
      const n = Number(t.text.trim());
      if (t.text.trim() === "" || !Number.isFinite(n)) {
        throw new ProtocolError(`rTorrent's answer holds <${t.name}>${t.text}</${t.name}> — answer refused`);
      }
      return n;
    }
    case "boolean":
      return t.text.trim() === "1";
    case "string":
      return t.text;
    case "base64":
      return Buffer.from(t.text, "base64").toString("utf8");
    case "nil":
      return null;
    case "array":
      return (child(t, "data")?.children ?? []).map(valueOf);
    case "struct":
      return Object.fromEntries(t.children.map(m => [child(m, "name")?.text ?? "", valueOf(child(m, "value"))]));
    default:
      throw new ProtocolError(`rTorrent's answer holds an unknown type <${t.name}> — answer refused`);
  }
}

/**
 * @param text a `methodResponse` document
 * @returns the result; a `<fault>` and anything that is no answer throw a ProtocolError
 */
export function parseResponse(text: string): unknown {
  const resp = child(tree(text), "methodResponse");
  if (!resp) {
    throw new ProtocolError("rTorrent's answer is no XML-RPC methodResponse — answer refused");
  }
  const fault = child(resp, "fault");
  if (fault) {
    const f = valueOf(child(fault, "value")) as { faultString?: unknown } | null;
    // a `<fault>` answer: rTorrent refused the call — its `faultString` says why
    throw new ProtocolError(typeof f?.faultString === "string" ? f.faultString : "rTorrent refused the call");
  }
  return valueOf(child(child(child(resp, "params"), "param"), "value"));
}

/**
 * One result of a `system.multicall`: a one-element list, or a fault struct for that call alone.
 *
 * @param entry the entry
 * @param method the method it answers, for the error text
 * @returns the result
 */
export function multicallResult(entry: unknown, method: string): unknown {
  if (Array.isArray(entry) && entry.length === 1) {
    return entry[0];
  }
  const f = entry as { faultString?: unknown } | null;
  if (f && typeof f === "object" && "faultString" in f) {
    throw new ProtocolError(`${method}: ${typeof f.faultString === "string" ? f.faultString : "refused"}`);
  }
  throw new ProtocolError(`rTorrent's answer to ${method} has lost its shape — answer refused`);
}
