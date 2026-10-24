/* eslint-disable no-control-regex -- 制御文字そのものを見つけるための式。 */
import { visible } from "../../../hl7-receiver/visible";

export type Header = {
  sendingApplication: string;
  sendingFacility: string;
  receivingApplication: string;
  receivingFacility: string;
  controlId: string;
  trigger: string;
};

export type Field = string[][][];

export interface Message {
  header: Header;
  segments: {
    name: string;
    fields: Field[];
  }[];
}

export type ParseResult = {
  ok: true;
  msg: Message;
} | {
  ok: false;
  reason: string;
  header?: Header;
};
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const escapes: Record<string, string> = { F: "|", S: "^", T: "&", R: "~", E: "\\" };

function decode(s: string): string {
  const value = s.replace(/\\([^\\]*)\\/g, (_, code: string) => {
    if (!Object.hasOwn(escapes, code)) {
      const byte = /^X([0-9a-f]{2})$/i.exec(code);
      const hint = byte ? visible(String.fromCharCode(parseInt(byte[1]!, 16))) : visible(code);
      throw new Error(`扱わないエスケープ：${hint}`);
    }
    return escapes[code]!;
  });
  // 閉じていないエスケープも断る。戻した E は許す。
  if (s.replace(/\\[FSTRE]\\/g, "").includes("\\")) {
    throw new Error("エスケープの形が違う");
  }
  if (controls.test(value) || visible(value) !== value) {
    throw new Error(`値に制御文字がある：${visible(value)}`);
  }
  return value;
}

function splitSegments(lines: string[]): Message["segments"] {
  return lines.map((line, i) => {
    const raw = line.split("|");
    const name = raw.shift()!;
    if (!/^[A-Z0-9]{3}$/.test(name) || (i > 0 && name === "MSH")) {
      throw new Error("セグメントの形が違う");
    }
    // 区切ってから戻す。戻した区切りの字は成分に残す（design.md §7）。
    const rawFields = i === 0 ? ["", "|", ...raw] : ["", ...raw];
    const fields = rawFields.map((text, index): Field => {
      if (i === 0 && index < 3) {
        return [[[text]]];
      }
      return text.split("~").map(repetition => repetition.split("^").map(component => component.split("&").map(decode)));
    });
    return { name, fields };
  });
}

function checkFieldShapes(segments: Message["segments"]): void {
  const shape: Record<string, Record<number, [number, number]>> = {
    MSH: {
      3: [1, 3],
      4: [1, 3],
      5: [1, 3],
      6: [1, 3],
      9: [1, 3],
      10: [1, 1],
      11: [1, 1],
      12: [1, 1],
      18: [1, 1]
    },
    PID: { 3: [4, 5], 5: [3, 8], 7: [1, 1], 8: [1, 1] },
    MRG: { 1: [4, 5] },
    ORC: { 1: [1, 1] },
    OBR: { 18: [1, 1] },
    ZDS: { 1: [1, 4] },
  };
  for (const segment of segments) {
    for (const [index, [repetitions, components]] of Object.entries(shape[segment.name] ?? {})) {
      const field = segment.fields[Number(index)] ?? [];
      const isPatientId = (segment.name === "PID" && index === "3") || (segment.name === "MRG" && index === "1");
      const invalid = field.some(repetition => {
        const invalidComponent = repetition.some((component, i) => {
          const maxSubcomponents = isPatientId && i === 3 ? 3 : 1;
          return component.length > maxSubcomponents;
        });
        return repetition.length > components || invalidComponent;
      });
      if (field.length > repetitions || invalid) {
        throw new Error("欄の形が違う");
      }
    }
  }
}
/** UTF-8 と欄の形を確かめ、エスケープを戻した階層を返す（design.md §7）。 */
export function parseMessage(buffer: Buffer): ParseResult {
  let header: Header | undefined;
  try {
    // 後ろのセグメントの UTF-8 が壊れていても、読める MSH-10 は AR に写す。
    const end = buffer.indexOf(13);
    const first = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end < 0 ? buffer.length : end));
    const msh = first.split("|");
    if (first.startsWith("MSH|")) {
      header = {
        sendingApplication: msh[2] ?? "",
        sendingFacility: msh[3] ?? "",
        receivingApplication: msh[4] ?? "",
        receivingFacility: msh[5] ?? "",
        controlId: msh[9] ?? "",
        trigger: (msh[8] ?? "").split("^")[1] ?? ""
      };
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    const lines = text.split(/\r\n?/);
    while (lines.at(-1) === "")
      lines.pop();
    if (!first.startsWith("MSH|^~\\&|")) {
      throw new Error("区切りが違う");
    }
    if (msh[11] !== "2.3.1") {
      throw new Error("HL7 v2.3.1 だけを扱う");
    }
    if (msh[17] && msh[17] !== "UNICODE UTF-8") {
      throw new Error("文字コードが違う");
    }
    if (!msh[17] && /[^\x00-\x7f]/.test(text)) {
      throw new Error("MSH-18 が空のときは ASCII だけを扱う");
    }
    const segments = splitSegments(lines);
    checkFieldShapes(segments);
    if (!header?.controlId || [...header.controlId].length > 20 || /[\s|^~\\&]/u.test(header.controlId)) {
      throw new Error("MSH-10 が正しくない");
    }
    return { ok: true, msg: { header: header!, segments } };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof TypeError ? "UTF-8 として正しくない" : e instanceof Error ? e.message : "解析できない",
      header
    };
  }
}
/** 指定のセグメントの欄を返す。無い欄は空として扱う。 */
export function field(msg: Message, segment: string, index: number): Field {
  return msg.segments.find((s) => s.name === segment)?.fields[index] ?? [];
}
/** 単一値の欄から先頭の成分を読む。 */
export const value = (f: Field): string => f[0]?.[0]?.[0] ?? "";
