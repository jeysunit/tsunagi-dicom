/* eslint-disable no-control-regex -- 制御文字そのものを見つけるための式。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { visible } from "../../hl7-receiver/visible";
import { parseMessage, field, value } from "@/lib/hl7/message";
import { extractUpdate } from "@/lib/hl7/update";
import { buildAck } from "@/lib/hl7/ack";
const example = (name = "a40") => readFileSync(`tests/fixtures/hl7/${name}.hl7`);
const update = (text: string) => {
  const parsed = parseMessage(Buffer.from(text));
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return extractUpdate(parsed.msg);
};
const changed = (segment: string, n: number, v: string, name = "a40") => example(name).toString().split("\r").map((s) => {
  const f = s.split("|");
  if (f[0] === segment) {
    f[n] = v;
  }
  return f.join("|");
}).join("\r");

describe("HL7 の解析と反映の中身", () => {
  it.each(["a40", "a08", "orm"])("送り手の例 %s は CR 区切りで読める", (name) => {
    expect(example(name).includes(10)).toBe(false);
    const parsed = parseMessage(example(name));
    expect(parsed.ok).toBe(true);
    const result = update(example(name).toString());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.command.patientId).toBe("P000001");
    if (name === "orm") {
      expect(result.command).toMatchObject({
        kind: "ORM",
        accession: "RE202610210001",
        uid: "2.25.67256859653214869994870466343258677753"
      });
    } else {
      expect(result.command.attributes).toEqual({
        PatientName: "TANAKA^HIROSHI=田中^博=タナカ^ヒロシ",
        PatientBirthDate: "19980312",
        PatientSex: "M"
      });
    }
    if (name === "a40") {
      expect(result.command.priorPatientId).toBe("ER2026102400");
    }
  });
  it("CR の直後の LF は読み飛ばす", () => expect(parseMessage(Buffer.from(example().toString().replaceAll("\r", "\r\n"))).ok).toBe(true));
  it.each([
    "",
    "PID|1",
    changed("PID", 5, "A\\constructor\\"),
    changed("PID", 5, "A\\toString\\"),
    example().toString().replace("MSH|", "MSH*"),
    example().toString().replace("^~\\&", "^~\\!"),
    changed("MSH", 11, "2.5.1"),
    changed("MSH", 17, "ISO IR 87"),
    changed("PID", 5, "A\\X1B\\"),
    changed("PID", 5, "A\\H\\"),
    changed("PID", 5, "A\\F"),
    changed("PID", 5, "A\x1b[31m"),
    changed("PID", 5, "A\tB"),
    changed("PID", 5, "A\u0080"),
  ])("壊れた形は AR にする %s", (text) => expect(parseMessage(Buffer.from(text))).toMatchObject({ ok: false }));
  it("不正な UTF-8 を断る", () => expect(parseMessage(Buffer.from([0xc3, 0x28])).ok).toBe(false));
  it("PID の UTF-8 が壊れても、読める MSH-10 は AR に写す", () => {
    const header = example().subarray(0, example().indexOf(13) + 1);
    const p = parseMessage(Buffer.concat([header, Buffer.from([0xc3, 0x28])]));
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(buildAck("AR", p.reason, p.header)).toContain("MSA|AR|20261024201530A40A|");
    }
  });
  it("5 つのエスケープは、階層を分けた後で戻す", () => {
    const p = parseMessage(Buffer.from(changed("PID", 5, "A\\F\\B\\S\\C\\T\\D\\R\\E\\E\\F")));
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(value(field(p.msg, "PID", 5))).toBe("A|B^C&D~E\\F");
    }
  });
  it.each(["", " ", " P1", "P1 ", "A*", "A?", "A\\E\\B", "A".repeat(65)])(
    "患者 ID を断る %s",
    (id) => expect(update(changed("PID", 3, id))).toMatchObject({ ok: false, code: "AE" })
  );
  it(
    "PI の繰り返しを選ぶ",
    () => expect(update(changed("PID", 3, "OTHER^^^OTHER^AN~P2^^^RIS_EMU^PI"))).toMatchObject({ command: { patientId: "P2" } })
  );
  it("発番元が一致しなければ先頭を使わず AE", () => expect(update(changed("PID", 3, "P2^^^^AN~P3"))).toMatchObject({ ok: false, code: "AE" }));
  it(
    "氏名の順の代替と接頭辞・接尾辞",
    () => expect(update(changed("PID", 5, "F^G^M^S^P~漢^字~か^な"))).toMatchObject(
      { command: { attributes: { PatientName: "F^G^M^P^S=漢^字=か^な" } } }
    )
  );
  it(
    "氏名の A/I/P は順に依らない",
    () => expect(update(changed("PID", 5, "か^な^^^^^^P~F^G^^^^^^A~漢^字^^^^^^I"))).toMatchObject(
      { command: { attributes: { PatientName: "F^G=漢^字=か^な" } } }
    )
  );
  it.each([
    "00000101",
    "20260229",
    "20261301",
    "20260431",
    "202610",
    "abcd0101"
  ])("生年月日を断る %s", (birth) => expect(update(changed("PID", 7, birth))).toMatchObject({ ok: false, code: "AE" }));
  it(
    "生年月日の時刻は先頭 8 桁を使う",
    () => expect(update(changed("PID", 7, "20240229123000"))).toMatchObject({ command: { attributes: { PatientBirthDate: "20240229" } } })
  );
  it("明示の削除は AE", () => {
    const text = changed("PID", 5, '""').split("\r").map((s) => {
      if (!s.startsWith("PID|")) {
        return s;
      }
      const f = s.split("|");
      f[7] = '""';
      f[8] = "U";
      return f.join("|");
    }).join("\r");
    expect(update(text)).toMatchObject({ ok: false, code: "AE" });
  });
  it.each(["X", "m"])("性別を断る %s", (sex) => expect(update(changed("PID", 8, sex))).toMatchObject({ ok: false, code: "AE" }));
  it.each(["ADT^A03", "OMI^O23"])(
    "扱わない種類 %s",
    (type) => expect(update(changed("MSH", 8, type))).toMatchObject({ ok: false, code: "AR" })
  );
  // RAD-13 の CA・DC・XO を受けるようにしたので、断るのは表に無い ORC-1 だけ（design.md §16）
  it.each(["OC", "SC", "nw", ""])("ORM の ORC-1 %s は AR", (control) =>
    expect(update(changed("ORC", 1, control, "orm"))).toMatchObject({ ok: false, code: "AR" }));
  it.each(["NW", "CA", "DC", "XO"])("ORM の ORC-1 %s を受ける", (control) =>
    expect(update(changed("ORC", 1, control, "orm"))).toMatchObject({ ok: true, command: { kind: "ORM", control } }));
  it.each(["", "1..2", "1.a", "1.02", "1." + "2".repeat(64)])(
    "UID を断る %s",
    (uid) => expect(update(changed("ZDS", 1, uid, "orm"))).toMatchObject({ ok: false, code: "AE" })
  );
  it("MSH-18 が空で日本語があれば断る", () => expect(parseMessage(Buffer.from(changed("MSH", 17, ""))).ok).toBe(false));
  it("発番元の subcomponent は分けて読む", () => {
    const p = parseMessage(Buffer.from(changed("PID", 3, "P1^^^ISSUER&1.2.3&ISO^PI")));
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(field(p.msg, "PID", 3)[0]?.[3]).toEqual(["ISSUER", "1.2.3", "ISO"]);
    }
  });
  it("MSH-9 の構造の名前を見ない", () => expect(update(changed("MSH", 8, "ADT^A08^ADT_A01"))).toMatchObject({ command: { kind: "A08" } }));
});

describe("見える文字と ACK", () => {
  it.each([
    0,
    9,
    27,
    31,
    127,
    128,
    159,
    1564,
    8206,
    8207,
    8232,
    8233,
    8234,
    8238,
    8294,
    8297
  ])("制御文字 %i", (code) => expect(visible(String.fromCharCode(code))).toBe(`\\u${code.toString(16).toUpperCase().padStart(4, "0")}`));
  it("日本語はそのまま", () => expect(visible("田中^博=たなか")).toBe("田中^博=たなか"));
  it.each(["AA", "AE", "AR"] as const)("%s の MSA と ERR", (code) => {
    const p = parseMessage(example());
    if (!p.ok) {
      throw new Error();
    }
    const ack = buildAck(code, "受理した", p.msg.header);
    expect(ack).toContain(`MSA|${code}|20261024201530A40A|受理した\r`);
    expect(ack.split("\r")[0]!.split("|")[17]).toBe("UNICODE UTF-8");
    expect(ack.includes("ERR|")).toBe(code !== "AA");
    expect(ack).toContain("MSH|^~\\&|PACS|PACS|RIS_EMU|TEST_HOSPITAL|");
  });
  it("ERR-1 は ELD として読み、見える制御文字の文を保つ", () => {
    const parsed = parseMessage(Buffer.from(buildAck("AE", "bad\x1b|^&")));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(field(parsed.msg, "ERR", 1)[0]?.[3]).toEqual(["207", "bad\\u001B|^&", "HL70357"]);
    }
  });
  it("MSH が無ければ MSA-2 は空", () => expect(buildAck("AR", "bad")).toContain("MSA|AR||bad\r"));
  it("MSH の値を ACK に安全に写す", () => {
    const p = parseMessage(Buffer.from(changed("MSH", 2, "\x1b[31m")));
    expect(p.ok).toBe(false);
    const ack = buildAck("AR", "bad\n\u202e|^", p.ok ? p.msg.header : p.header);
    expect(ack).not.toMatch(/[\x1b\n\u202e]/);
  });
});
