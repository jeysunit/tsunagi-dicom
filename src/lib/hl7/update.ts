/* eslint-disable no-control-regex -- 制御文字そのものを見つけるための式。 */
import { field, value, type Field, type Message } from "./message";

export interface Command {
  kind: "A40" | "A08" | "ORM";
  patientId: string;
  priorPatientId?: string;
  attributes: Record<string, string>;
  uid?: string;
  accession?: string;
}

export type UpdateResult = {
  ok: true;
  command: Command;
} | {
  ok: false;
  code: "AE" | "AR";
  reason: string;
};

function patientId(f: Field, issuer: string): string {
  if (f.some(r => r[3]?.slice(1).some(Boolean))) {
    throw new Error("発番元の universal ID は扱わない");
  }
  const candidates = f.filter(r => r[3]?.[0] === issuer && ["", "PI"].includes(r[4]?.[0] ?? ""));
  if (candidates.length !== 1) {
    throw new Error(candidates.length ? "患者 ID をどれか決められない" : "発番元の違う患者 ID");
  }
  const rep = candidates[0];
  const id = rep?.[0]?.[0] ?? "";
  if (!id || [...id].length > 64 || id.trim() !== id || /[\\*?\u0000-\u001f\u007f-\u009f]/.test(id)) {
    throw new Error("患者 ID が正しくない");
  }
  return id;
}

// PN の順とグループの長さは、並べ替えた後で確かめる（design.md §8）。
function patientName(fieldValue: Field): string | undefined {
  const names = ["", "", ""];
  fieldValue.forEach((r, i) => {
    const marker = r[7]?.[0] ?? "";
    const group = marker ? ["A", "I", "P"].indexOf(marker) : i;
    if (group < 0 || group > 2) {
      throw new Error("氏名の表記の種類が違う");
    }
    if (r.slice(0, 5).some(c => /[\\=^]/.test(c[0] ?? ""))) {
      throw new Error("氏名の成分に区切りがある");
    }
    names[group] = [0, 1, 2, 4, 3].map((n) => r[n]?.[0] ?? "").join("^").replace(/\^+$/, "");
  });
  if (names.some(n => [...n].length > 64)) {
    throw new Error("氏名のグループが長すぎる");
  }
  return names.some(Boolean) ? names.join("=").replace(/=+$/, "") : undefined;
}

function birthDate(birth: string): string | undefined {
  if (!birth || birth === '""') return undefined;
  const date = birth.slice(0, 8);
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  if (!/^\d{8}(?:\d{2})*(?:[.+-].*)?$/.test(birth)
    || Number(date.slice(0, 4)) < 1 || !Number.isFinite(Date.parse(iso))
    || new Date(iso).toISOString().slice(0, 10) !== iso) {
    throw new Error("生年月日が正しくない");
  }
  return date;
}

/** 扱う構造と DICOM に入る値を確かめ、空欄を変更対象から外す（design.md §7〜§9）。 */
export function extractUpdate(msg: Message, issuer = "RIS_EMU"): UpdateResult {
  const type = value(field(msg, "MSH", 9));
  const trigger = msg.header.trigger;
  if (!(type === "ADT" && ["A40", "A08"].includes(trigger)) && !(type === "ORM" && trigger === "O01")) {
    return { ok: false, code: "AR", reason: "扱わないメッセージ" };
  }
  if (type === "ORM" && value(field(msg, "ORC", 1)) !== "NW") {
    return { ok: false, code: "AR", reason: "ORC-1 は NW だけを扱う" };
  }
  const structure = field(msg, "MSH", 9)[0]?.[2]?.[0] ?? "";
  const allowed = type === "ORM" ? ["", "ORM_O01"] : trigger === "A40" ? ["", "ADT_A39"] : ["", "ADT_A01", "ADT_A08"];
  if (!allowed.includes(structure)) {
    return { ok: false, code: "AR", reason: "扱わない構造の名前" };
  }
  for (const segment of [
    "MSH",
    "PID",
    ...(trigger === "A40" ? ["MRG"] : []),
    ...(type === "ORM" ? ["ORC", "OBR", "ZDS"] : [])
  ]) {
    if (msg.segments.filter(s => s.name === segment).length !== 1) {
      return { ok: false, code: "AR", reason: "セグメントの数が違う" };
    }
  }
  const markers = field(msg, "PID", 5).map(r => r[7]?.[0] ?? "");
  if (markers.some(Boolean) && (markers.some(m => !["A", "I", "P"].includes(m)) || new Set(markers).size !== markers.length)) {
    return { ok: false, code: "AR", reason: "氏名の表記が重複または混在している" };
  }
  try {
    for (const [segment, index] of [
      ["PID", 3],
      ["PID", 5],
      ["PID", 7],
      ["PID", 8],
      ["MRG", 1],
      ["OBR", 18]
    ] as const)
      if (field(msg, segment, index).flat(2).includes('""')) {
        throw new Error("明示の削除は扱わない");
      }
    const id = patientId(field(msg, "PID", 3), issuer);
    const attributes: Record<string, string> = {};
    const name = patientName(field(msg, "PID", 5));
    if (name !== undefined) attributes.PatientName = name;
    const birth = birthDate(value(field(msg, "PID", 7)));
    if (birth !== undefined) attributes.PatientBirthDate = birth;
    const sex = value(field(msg, "PID", 8));
    if (sex && sex !== "U" && sex !== '""') {
      if (!["M", "F", "O"].includes(sex)) {
        throw new Error("性別が正しくない");
      }
      attributes.PatientSex = sex;
    }
    if (type === "ORM") {
      const uid = value(field(msg, "ZDS", 1));
      const accession = value(field(msg, "OBR", 18));
      if (uid.length > 64 || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*))+$/.test(uid)) {
        throw new Error("StudyInstanceUID が正しくない");
      }
      if (!accession || [...accession].length > 16 || /[\\]/.test(accession)) {
        throw new Error("受付番号が正しくない");
      }
      return {
        ok: true,
        command: { kind: "ORM", patientId: id, attributes: {}, uid, accession }
      };
    }
    const priorPatientId = trigger === "A40" ? patientId(field(msg, "MRG", 1), issuer) : undefined;
    // 患者 ID の変わらない A40 は、元を消す書き換え（KeepSource: false）が検査ごと消すので断る（design.md §4）
    if (priorPatientId === id) {
      throw new Error("旧い患者 ID と新しい患者 ID が同じ");
    }
    return {
      ok: true,
      command: {
        kind: trigger as "A40" | "A08",
        patientId: id,
        priorPatientId,
        attributes
      }
    };
  } catch (e) {
    return { ok: false, code: "AE", reason: (e as Error).message };
  }
}
