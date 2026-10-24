/* eslint-disable no-control-regex -- 制御文字そのものを見つけるための式。 */
import { randomUUID } from "node:crypto";
import { visible } from "../../../hl7-receiver/visible";
import type { Header } from "./message";
const clean = (s = "") => visible(s).replace(/[|^~\\&]/g, "");

/** 送り手の欄を安全に写し、受理・反映失敗・拒否の ACK を作る（design.md §11・§14）。 */
export function buildAck(code: "AA" | "AE" | "AR", reason: string, header?: Header): string {
  const escape: Record<string, string> = { "|": "F", "^": "S", "~": "R", "&": "T", "\\": "E" };
  const text = visible(reason).replace(/[|^~&\\]/g, (c) => `\\${escape[c]}\\`);
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds()
  ].map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0")).join("");
  const msh = [
    "MSH",
    "^~\\&",
    clean(header?.receivingApplication),
    clean(header?.receivingFacility),
    clean(header?.sendingApplication),
    clean(header?.sendingFacility),
    timestamp,
    "",
    `ACK^${clean(header?.trigger)}`,
    randomUUID().replaceAll("-", "").slice(0, 20),
    "P",
    "2.3.1"
  ];
  if (/[^\x00-\x7f]/.test(msh.join("") + text)) {
    while (msh.length < 17)
      msh.push("");
    msh.push("UNICODE UTF-8");
  }
  // ERR-1 は ELD。第4成分の CE に、誤りの番号・文・表の名前を入れる。
  const err = code === "AA" ? "" : `ERR|^^^207&${text}&HL70357\r`;
  return `${msh.join("|")}\rMSA|${code}|${clean(header?.controlId)}|${text}\r${err}`;
}
