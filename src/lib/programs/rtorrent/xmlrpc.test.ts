import { loadFixture } from "../../../../test/helpers/fixtures";
import { ProtocolError } from "../../core/errors";
import { methodCall, multicallResult, parseResponse } from "./xmlrpc";

/**
 * @param version recorded version
 * @param state state folder
 * @param name file name
 * @returns the recorded XML
 */
const xml = (version: string, state: string, name: string): string =>
  loadFixture("rtorrent", version, state, name).body as string;

describe("rTorrent XML-RPC request", () => {
  it("writes the target first, numbers as i4 or i8, structs and arrays, and escapes text", () => {
    expect(methodCall("d.stop", ["ABC"])).toBe(
      '<?xml version="1.0"?><methodCall><methodName>d.stop</methodName><params><param><value><string>ABC</string>' +
        "</value></param></params></methodCall>",
    );
    const body = methodCall("x", ["", 2048000, 2 ** 31, true, [1], { methodName: "a<b&c" }]);
    expect(body).toContain("<value><string></string></value>");
    expect(body).toContain("<value><i4>2048000</i4></value>");
    expect(body).toContain("<value><i8>2147483648</i8></value>");
    expect(body).toContain("<value><boolean>1</boolean></value>");
    expect(body).toContain("<value><array><data><value><i4>1</i4></value></data></array></value>");
    expect(body).toContain("<member><name>methodName</name><value><string>a&lt;b&amp;c</string></value></member>");
  });
});

describe("rTorrent XML-RPC answer", () => {
  for (const version of ["0.9.8", "0.16.25"]) {
    it(`reads the recorded answers of ${version} — xmlrpc-c's line breaks and 0.16's own writer alike`, () => {
      expect(parseResponse(xml(version, "auth", "version"))).toBe(version);
      expect(parseResponse(xml(version, "commands", "d-stop"))).toBe(0);
      const poll = parseResponse(xml(version, "running", "poll")) as unknown[][];
      expect(poll).toHaveLength(5);
      const rows = poll[4][0] as unknown[][];
      expect(rows.map(r => r[1])).toContain("big.bin");
      expect(typeof rows[0][8]).toBe("number");
    });

    it(`throws the fault of ${version} for an unknown hash as a refusal with rTorrent's text`, () => {
      expect(() => parseResponse(xml(version, "commands", "d-unknown"))).toThrow(ProtocolError);
      expect(() => parseResponse(xml(version, "commands", "d-unknown"))).toThrow(/info-hash/i);
    });

    it(`throws the fault of one call inside a multicall of ${version}, naming its method`, () => {
      const [ok, failed] = parseResponse(xml(version, "commands", "multicall-fault")) as unknown[];
      expect(typeof multicallResult(ok, "throttle.global_down.rate")).toBe("number");
      expect(() => multicallResult(failed, "no.such.method")).toThrow(/no\.such\.method: Method 'no\.such\.method'/i);
    });
  }

  it("refuses a cut answer, a mismatched element, a document without methodResponse and an unknown type", () => {
    const whole = xml("0.16.25", "running", "poll");
    for (const cut of [whole.slice(0, whole.length / 2), whole.slice(0, -20)]) {
      expect(() => parseResponse(cut)).toThrow(ProtocolError);
    }
    expect(() => parseResponse("<methodResponse><params><param><value><i8>1</i4></value>")).toThrow(/closes <i4>/);
    expect(() => parseResponse("<html><body>401 Authorization Required</body></html>")).toThrow(/no XML-RPC/);
    expect(() =>
      parseResponse(
        "<methodResponse><params><param><value><dateTime.iso8601>x</dateTime.iso8601></value></param>" +
          "</params></methodResponse>",
      ),
    ).toThrow(/unknown type/);
    expect(() =>
      parseResponse("<methodResponse><params><param><value><i8></i8></value></param></params></methodResponse>"),
    ).toThrow(ProtocolError);
    expect(() => parseResponse("<methodResponse><params></params></methodResponse>")).toThrow(/no value/);
  });

  it("reads entities, CDATA, base64, nil and an untyped value", () => {
    const doc = (v: string): string =>
      `<methodResponse><params><param><value>${v}</value></param></params></methodResponse>`;
    expect(parseResponse(doc("<string>a&amp;b &#228;&#xE4;</string>"))).toBe("a&b ää");
    expect(parseResponse(doc("<string><![CDATA[<x>]]></string>"))).toBe("<x>");
    expect(parseResponse(doc(`<base64>${Buffer.from("hi").toString("base64")}</base64>`))).toBe("hi");
    expect(parseResponse(doc("<nil/>"))).toBeNull();
    expect(parseResponse(doc("plain"))).toBe("plain");
  });

  it("refuses a multicall entry that is neither a one-element list nor a fault", () => {
    expect(() => multicallResult([1, 2], "x")).toThrow(/lost its shape/);
    expect(() => multicallResult("x", "x")).toThrow(/lost its shape/);
  });
});
