import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilePicker } from "@/components/ui/file-picker";
import { checkHead, formatSize, readPreviewTags } from "@/lib/import/dicom-preview";
import {
  abortBody,
  addedMessage,
  addFiles,
  badgeOf,
  cancelWaiting,
  countItems,
  formbarText,
  isResolvable,
  nextResolvable,
  RESOLVED_NOTE,
  resolveItem,
  resolvedMessage,
  resultNotice,
  seriesImageText,
  skippedNote,
  sortForList,
  type PickItem,
} from "@/lib/import/picker-model";

// ファイルを選ぶ部品（docs/design-system/parts.md の「ファイルを選ぶ部品」）の、ブラウザでの頭の読み取り・数え方・文言・形。
// 押す・ドロップする・焦点の動きはブラウザの動きなので、インポートの画面の e2e で見る。

const MB = 1024 * 1024;
const enc = new TextEncoder();

/** Explicit VR Little Endian の要素（短い VR） */
function el(group: number, element: number, vr: string, value: Uint8Array | string): Uint8Array {
  let v = typeof value === "string" ? enc.encode(value) : value;
  if (v.length % 2) v = Uint8Array.from([...v, vr === "UI" ? 0 : 0x20]);
  const long = ["OB", "OW", "SQ", "UN", "UT"].includes(vr);
  const out = new Uint8Array((long ? 12 : 8) + v.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, group, true);
  dv.setUint16(2, element, true);
  out[4] = vr.charCodeAt(0);
  out[5] = vr.charCodeAt(1);
  if (long) dv.setUint32(8, v.length, true);
  else dv.setUint16(6, v.length, true);
  out.set(v, long ? 12 : 8);
  return out;
}

/** Implicit VR Little Endian の要素 */
function implicit(group: number, element: number, value: string): Uint8Array {
  let v = enc.encode(value);
  if (v.length % 2) v = Uint8Array.from([...v, 0x20]);
  const out = new Uint8Array(8 + v.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, group, true);
  dv.setUint16(2, element, true);
  dv.setUint32(4, v.length, true);
  out.set(v, 8);
  return out;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

function dicom(dataset: Uint8Array[], syntax = "1.2.840.10008.1.2.1"): Uint8Array {
  const meta = concat(el(0x0002, 0x0003, "UI", "1.2.3.4"), el(0x0002, 0x0010, "UI", syntax));
  const groupLength = el(0x0002, 0x0000, "UL", new Uint8Array(new Uint32Array([meta.length]).buffer));
  return concat(new Uint8Array(128), enc.encode("DICM"), groupLength, meta, ...dataset);
}

const basic = () =>
  dicom([
    el(0x0008, 0x0005, "CS", "ISO_IR 192"),
    el(0x0008, 0x0020, "DA", "20261031"),
    el(0x0008, 0x0060, "CS", "CT"),
    el(0x0010, 0x0010, "PN", "Shiken^Taro=試験^太郎=しけん^たろう"),
    el(0x0010, 0x0020, "LO", "P000101"),
    el(0x0020, 0x0011, "IS", " 0002"),
    el(0x0020, 0x0013, "IS", "15"),
  ]);

describe("頭の読み取り（ブラウザの目安）", () => {
  it("6 つの値を読む。氏名は元の値、検査日は yyyy/MM/dd、番号は先頭の 0 を外す", () => {
    expect(readPreviewTags(basic())).toEqual({
      patientId: "P000101",
      patientName: "Shiken^Taro=試験^太郎=しけん^たろう",
      studyDate: "2026/10/31",
      modality: "CT",
      seriesNumber: "2",
      instanceNumber: "15",
    });
  });

  it("Implicit VR Little Endian も読む", () => {
    const file = dicom([implicit(0x0008, 0x0060, "MR"), implicit(0x0010, 0x0020, "IMP01")], "1.2.840.10008.1.2");
    expect(readPreviewTags(file)).toMatchObject({ modality: "MR", patientId: "IMP01" });
  });

  it("Big Endian と Deflated の転送構文は読めない（null。列は全部「—」）", () => {
    expect(readPreviewTags(dicom([el(0x0010, 0x0020, "LO", "X")], "1.2.840.10008.1.2.2"))).toBeNull();
    expect(readPreviewTags(dicom([el(0x0010, 0x0020, "LO", "X")], "1.2.840.10008.1.2.1.99"))).toBeNull();
  });

  it("長さの未定義のシーケンスの中の同じタグは読まない（最上位だけ）", () => {
    const sq = new Uint8Array(12);
    const dv = new DataView(sq.buffer);
    dv.setUint16(0, 0x0008, true);
    dv.setUint16(2, 0x1115, true);
    sq[4] = "S".charCodeAt(0);
    sq[5] = "Q".charCodeAt(0);
    dv.setUint32(8, 0xffffffff, true);
    const item = new Uint8Array(8);
    new DataView(item.buffer).setUint16(0, 0xfffe, true);
    new DataView(item.buffer).setUint16(2, 0xe000, true);
    new DataView(item.buffer).setUint32(4, 0xffffffff, true);
    const itemEnd = new Uint8Array(8);
    new DataView(itemEnd.buffer).setUint16(0, 0xfffe, true);
    new DataView(itemEnd.buffer).setUint16(2, 0xe00d, true);
    const seqEnd = new Uint8Array(8);
    new DataView(seqEnd.buffer).setUint16(0, 0xfffe, true);
    new DataView(seqEnd.buffer).setUint16(2, 0xe0dd, true);
    const inner = el(0x0010, 0x0020, "LO", "INNER");
    const file = dicom([sq, item, inner, itemEnd, seqEnd, el(0x0010, 0x0020, "LO", "OUTER")]);
    expect(readPreviewTags(file)?.patientId).toBe("OUTER");
  });

  it("知らない文字コード・文字コードの無い ASCII の外のバイト・合わないバイトは空（化けた字を出さない）", () => {
    const sjis = Uint8Array.from([0x8e, 0x8e, 0x8c, 0xb1]); // 「試験」の Shift_JIS
    expect(readPreviewTags(dicom([el(0x0010, 0x0020, "LO", sjis)]))?.patientId).toBe("");
    expect(readPreviewTags(dicom([el(0x0008, 0x0005, "CS", "ISO_IR 999"), el(0x0010, 0x0020, "LO", sjis)]))?.patientId).toBe("");
    expect(readPreviewTags(dicom([el(0x0008, 0x0005, "CS", "ISO_IR 192"), el(0x0010, 0x0020, "LO", Uint8Array.from([0xff, 0xfe]))]))?.patientId).toBe("");
    // ISO_IR 13 は JIS X 0201（ローマ字と半角カナ）。Shift_JIS の漢字は読まない
    expect(readPreviewTags(dicom([el(0x0008, 0x0005, "CS", "ISO_IR 13"), el(0x0010, 0x0020, "LO", sjis)]))?.patientId).toBe("");
    expect(readPreviewTags(dicom([el(0x0008, 0x0005, "CS", "ISO_IR 13"), el(0x0010, 0x0020, "LO", Uint8Array.from([0x41, 0xbc, 0xb9, 0xdd]))]))?.patientId).toBe("Aｼｹﾝ");
    // Latin-1 の 0x80〜0x9F は字が無いので読まない。0xE9 は é
    expect(readPreviewTags(dicom([el(0x0008, 0x0005, "CS", "ISO_IR 100"), el(0x0010, 0x0010, "PN", Uint8Array.from([0x52, 0xe9]))]))?.patientName).toBe("Ré");
    expect(readPreviewTags(dicom([el(0x0008, 0x0005, "CS", "ISO_IR 100"), el(0x0010, 0x0010, "PN", Uint8Array.from([0x52, 0x85]))]))?.patientName).toBe("");
  });

  it("ISO 2022 IR 87（JIS X 0208）の氏名を読む", () => {
    // ESC $ B 「試験」 ESC ( B
    const jis = Uint8Array.from([0x1b, 0x24, 0x42, 0x3b, 0x6e, 0x38, 0x33, 0x1b, 0x28, 0x42]);
    const file = dicom([el(0x0008, 0x0005, "CS", "\\ISO 2022 IR 87"), el(0x0010, 0x0010, "PN", concat(enc.encode("Shiken="), jis))]);
    expect(readPreviewTags(file)?.patientName).toBe("Shiken=試験");
  });

  it("ISO 2022 IR 13\\ISO 2022 IR 87：半角カナ（8 ビット）と漢字（ESC $ B）を読み、区切りで G0 が ASCII に戻る。JIS X 0212 は読まない", () => {
    // ｼｹﾝ^ﾀﾛｳ=ESC $ B 試験 ESC ( B ^ ESC $ B 太郎 ESC ( B（区切りの前で ASCII に戻し、区切りの後で置き直す。PS3.5 の例の形）
    const name = Uint8Array.from([
      0xbc, 0xb9, 0xdd, 0x5e, 0xc0, 0xdb, 0xb3, 0x3d,
      0x1b, 0x24, 0x42, 0x3b, 0x6e, 0x38, 0x33, 0x1b, 0x28, 0x42, 0x5e,
      0x1b, 0x24, 0x42, 0x42, 0x40, 0x4f, 0x3a, 0x1b, 0x28, 0x42,
    ]);
    const cs = el(0x0008, 0x0005, "CS", "ISO 2022 IR 13\\ISO 2022 IR 87");
    expect(readPreviewTags(dicom([cs, el(0x0010, 0x0010, "PN", name)]))?.patientName).toBe("ｼｹﾝ^ﾀﾛｳ=試験^太郎");
    const jisx0212 = Uint8Array.from([0x1b, 0x24, 0x28, 0x44, 0x30, 0x21, 0x1b, 0x28, 0x42]);
    expect(readPreviewTags(dicom([el(0x0008, 0x0005, "CS", "\\ISO 2022 IR 87\\ISO 2022 IR 159"), el(0x0010, 0x0010, "PN", jisx0212)]))?.patientName).toBe("");
    // 漢字のまま終わる・組の半端なバイトは読まない（化けた字を出さない）
    const broken = Uint8Array.from([0x1b, 0x24, 0x42, 0x3b, 0x6e, 0x38]);
    expect(readPreviewTags(dicom([el(0x0008, 0x0005, "CS", "\\ISO 2022 IR 87"), el(0x0010, 0x0010, "PN", broken)]))?.patientName).toBe("");
  });

  it("検査日は 8 桁の DA のときだけ。番号は IS の形（12 文字まで・32 ビットの整数）のときだけ", () => {
    const tags = readPreviewTags(dicom([el(0x0008, 0x0020, "DA", "2026.10.31"), el(0x0020, 0x0011, "IS", "99999999999"), el(0x0020, 0x0013, "IS", "1.5")]));
    expect(tags).toMatchObject({ studyDate: "", seriesNumber: "", instanceNumber: "" });
  });

  it("先頭の 64 KB に収まらない値は読まない（壊れていても止まる）", () => {
    const file = basic().slice(0, 200);
    expect(() => readPreviewTags(file)).not.toThrow();
  });
});

describe("DICOM か・上限か", () => {
  it("128 バイトの前置きの後に DICM が無いものは対象外", () => {
    expect(checkHead(enc.encode("hello"), 5, 256 * MB)).toEqual({ kind: "excluded", reason: "DICOM ファイルではありません" });
    const noMagic = new Uint8Array(200);
    expect(checkHead(noMagic, 200, 256 * MB)).toEqual({ kind: "excluded", reason: "DICOM ファイルではありません" });
    expect(checkHead(basic(), basic().length, 256 * MB).kind).toBe("dicom");
  });

  it("上限はバイトの実数で比べる。丸めた表示が上限と同じに見える超過は、バイト数を添える", () => {
    expect(checkHead(basic(), 256 * MB, 256 * MB).kind).toBe("dicom");
    expect(checkHead(basic(), 256 * MB + 1, 256 * MB)).toEqual({ kind: "excluded", reason: "上限（256 MB）を超えています（268,435,457 B）" });
    expect(checkHead(basic(), 300 * MB, 256 * MB)).toEqual({ kind: "excluded", reason: "上限（256 MB）を超えています" });
  });

  it("大きさは 1,024 進み。B は整数、KB・MB は 1 桁、GB は 2 桁。丸めて 1,024 になるときは次の単位", () => {
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1331)).toBe("1.3 KB");
    expect(formatSize(512 * 1024)).toBe("512.0 KB");
    expect(formatSize(1024 * 1024 - 1)).toBe("1.0 MB");
    expect(formatSize(19.5 * MB)).toBe("19.5 MB");
    expect(formatSize(1.2 * 1024 * MB)).toBe("1.20 GB");
  });
});

const file = (name: string) => ({ name });
function items(spec: Array<Partial<PickItem<{ name: string }>> & { name: string }>): PickItem<{ name: string }>[] {
  return spec.map((s, i) => ({ id: i + 1, key: s.name, file: file(s.name), dir: "", size: 1024, state: "wait", reason: "", off: false, tags: null, ...s }));
}

describe("数え方と文言（件 ＝ 対象外 ＋ 除外 ＋ 選択、選択 ＝ 成功 ＋ 失敗 ＋ 結果不明 ＋ 中止）", () => {
  it("続けて選ぶと足す。同じファイル（場所・大きさ・更新時刻）は足さず、数を返す。場所は名前と分ける", () => {
    const first = addFiles([], [{ file: file("a"), path: "CD/CT/IM0001", size: 10, lastModified: 1 }], 1);
    expect(first.fresh[0]).toMatchObject({ name: "IM0001", dir: "CD/CT/", state: "check" });
    const second = addFiles(first.items, [
      { file: file("a"), path: "CD/CT/IM0001", size: 10, lastModified: 1 },
      { file: file("b"), path: "IM0002", size: 10, lastModified: 1 },
    ], 2);
    expect(second.duplicates).toBe(1);
    expect(second.items.map((i) => i.name)).toEqual(["IM0001", "IM0002"]);
    expect(addedMessage([], 3, second.items)).toBe("同じ 3 件は追加していません。");
  });

  it("件数の行と操作の行：対象外・除外は 0 のものを出さない。前と後で「選択」を同じ数で出す", () => {
    const list = items([{ name: "readme.txt", state: "ex" }, { name: "IM1", off: true }, { name: "IM2", size: 2048 }, { name: "IM3" }]);
    const c = countItems(list);
    expect(c).toMatchObject({ total: 4, excluded: 1, removed: 1, selected: 2, selectedBytes: 3072 });
    expect(skippedNote(c)).toBe("（対象外 1・除外 1）");
    expect(skippedNote(countItems(items([{ name: "a" }])))).toBe("");
    expect(formbarText("idle", c)).toBe("選択 2 件・3.0 KB");
    expect(formbarText("idle", countItems([]))).toBe("ファイルを選択してください。");
    expect(formbarText("idle", countItems(items([{ name: "x", state: "ex" }])))).toBe("インポートできるファイルがありません。");
    const after = countItems(items([{ name: "a", state: "ok" }, { name: "b", state: "ng" }, { name: "c", state: "cx" }, { name: "d", off: true }]));
    expect(formbarText("done", after)).toBe("選択 3 件 → 成功 1・失敗 1・中止 1");
  });

  it("一覧の並び：失敗→対象外→それ以外。同じ並びの中は選んだ順。除外した行は元の場所", () => {
    const list = items([{ name: "a" }, { name: "b", state: "ex" }, { name: "c", off: true }, { name: "d", state: "ng" }, { name: "e" }]);
    expect(sortForList(list).map((i) => i.name)).toEqual(["d", "b", "a", "c", "e"]);
  });

  it("札：除外は off で決まり、対象外と同じ skip（—）。確認中とインポート中は wait、待ちは plan、中止は stop", () => {
    const [ex, off, check, run, wait, cx] = items([{ name: "a", state: "ex" }, { name: "b", off: true }, { name: "c", state: "check" }, { name: "d", state: "run" }, { name: "e" }, { name: "f", state: "cx" }]);
    expect(badgeOf(ex!)).toEqual({ kind: "skip", label: "対象外" });
    expect(badgeOf(off!)).toEqual({ kind: "skip", label: "除外" });
    expect(badgeOf(check!)).toEqual({ kind: "wait", label: "確認中" });
    expect(badgeOf(run!)).toEqual({ kind: "wait", label: "インポート中" });
    expect(badgeOf(wait!)).toEqual({ kind: "plan", label: "インポート待ち" });
    expect(badgeOf(cx!)).toEqual({ kind: "stop", label: "中止" });
  });

  it("中止：窓の本文は済んだ数と残りの数。中止の後は待っていた行を「中止」にする（除外は除外のまま）", () => {
    const list = items([{ name: "a", state: "ok" }, { name: "b", state: "run" }, { name: "c" }, { name: "d" }, { name: "e", off: true }]);
    expect(abortBody(list)).toBe("インポート済みの 1 件は保管に残ります。実行中の 1 件を終えたあと、残りの 2 件はインポートしません。");
    const { items: after, cancelled } = cancelWaiting(list);
    expect(cancelled).toBe(2);
    expect(after.map((i) => i.state)).toEqual(["ok", "run", "cx", "cx", "wait"]);
    expect(after[2]!.reason).toBe("中止したためインポートしていません");
  });

  it("結果の知らせ：全部成功は ok、失敗があれば err（alert）、中止は warn", () => {
    expect(resultNotice(countItems(items([{ name: "a", state: "ok" }, { name: "b", state: "ok" }])))).toEqual({ kind: "ok", text: "2 件（2.0 KB）をインポートしました。", alert: false });
    expect(resultNotice(countItems(items([{ name: "a", state: "ok" }, { name: "b", state: "ng" }])))).toMatchObject({
      kind: "err",
      alert: true,
      // 期待の変更：「失敗したファイルを選び直して、もう一度インポートしてください。」を外した（理由が「もう画像サーバーにある」の
      // ときは、選び直しても入らない。UX のレビューの指摘。docs/design-system/parts.md の「tsunagi で決めたこと」）
      text: "選択 2 件のうち 1 件をインポートしました。1 件は失敗しました（理由は各行の状態）。",
    });
    expect(resultNotice(countItems(items([{ name: "a", state: "ok" }, { name: "b", state: "cx" }])))).toEqual({
      kind: "warn",
      text: "1 件をインポートしました。残り 1 件は中止したためインポートしていません。",
      alert: false,
    });
  });

  it("結果不明（tsunagi で足した状態）：成功とも失敗とも数えず、札は unknown、並びは失敗と同じ、知らせは err で確かめる人と止まることを書く", () => {
    const list = items([{ name: "a", state: "ok" }, { name: "b", state: "uk", reason: "画像サーバーの答えが分かりません" }, { name: "c", state: "ng" }, { name: "d", state: "ex" }, { name: "e", off: true }]);
    const c = countItems(list);
    // 選択 ＝ 成功 ＋ 失敗 ＋ 結果不明 ＋ 中止
    expect(c).toMatchObject({ total: 5, selected: 3, ok: 1, ng: 1, unknown: 1, cancelled: 0 });
    expect(c.selected).toBe(c.ok + c.ng + c.unknown + c.cancelled);
    expect(formbarText("done", c)).toBe("選択 3 件 → 成功 1・失敗 1・結果不明 1");
    // 結果不明が 0 件のときは語を出さない（前の形のまま）
    expect(formbarText("done", countItems(items([{ name: "a", state: "ok" }])))).toBe("選択 1 件 → 成功 1・失敗 0");
    expect(badgeOf(list[1]!)).toEqual({ kind: "unknown", label: "結果不明" });
    expect(sortForList(list).map((i) => i.name)).toEqual(["b", "c", "d", "a", "e"]);
    expect(resultNotice(countItems(items([{ name: "a", state: "ok" }, { name: "b", state: "uk" }])))).toEqual({
      kind: "err",
      alert: true,
      text: "選択 2 件のうち 1 件をインポートしました。1 件は、画像サーバーに入ったか分かりません（各行の状態）。確かめるまで、同じ検査はインポートできません。管理者に確かめを頼んでください。",
    });
    expect(resultNotice(c).text).toBe(
      "選択 3 件のうち 1 件をインポートしました。1 件は失敗しました（理由は各行の状態）。1 件は、画像サーバーに入ったか分かりません（各行の状態）。確かめるまで、同じ検査はインポートできません。管理者に確かめを頼んでください。",
    );
    // 管理者には、管理者に頼む文を添えない（呼ぶ側が空を渡す）
    expect(resultNotice(countItems(items([{ name: "a", state: "uk" }])), "").text).toBe(
      "選択 1 件のうち 0 件をインポートしました。1 件は、画像サーバーに入ったか分かりません（各行の状態）。確かめるまで、同じ検査はインポートできません。",
    );
    // 中止と重なっても、結果不明は err（alert）にする
    expect(resultNotice(countItems(items([{ name: "a", state: "uk" }, { name: "b", state: "cx" }])))).toEqual({
      kind: "err",
      alert: true,
      text: "0 件をインポートしました。残り 1 件は中止したためインポートしていません。1 件は、画像サーバーに入ったか分かりません（各行の状態）。確かめるまで、同じ検査はインポートできません。管理者に確かめを頼んでください。",
    });
  });

  it("結果不明を確認して記録する：名指しを持つ結果不明の行だけが確認できる。記録すると札が替わり、名指しを外し、件数を数え直す", () => {
    const target = { requestId: "0b7d9c1e-2f3a-4b5c-9d6e-1f2a3b4c5d6e", studyInstanceUid: "1.2.3" };
    const list = items([
      { name: "a", state: "ok" },
      { name: "b", state: "uk", resolve: target },
      { name: "c", state: "uk" },
      { name: "d", state: "uk", resolve: target, off: true },
      { name: "e", state: "uk", resolve: { ...target, requestId: "1b7d9c1e-2f3a-4b5c-9d6e-1f2a3b4c5d6e" } },
    ]);
    // 名指しが無い行（BFF に届いたか分からない）・除外した行・結果不明でない行は確認できない
    expect(list.map(isResolvable)).toEqual([false, true, false, false, true]);
    const ok = resolveItem(list, 2, "success");
    expect(ok[1]).toMatchObject({ state: "ok", reason: RESOLVED_NOTE });
    expect(ok[1]).not.toHaveProperty("resolve");
    expect(badgeOf(ok[1]!)).toEqual({ kind: "ok", label: "成功" });
    // 選択の数は変わらず、結果不明が 1 減って成功が 1 増える（選択 ＝ 成功 ＋ 失敗 ＋ 結果不明 ＋ 中止）
    const before = countItems(list);
    const after = countItems(ok);
    expect(after.selected).toBe(before.selected);
    expect([after.ok, after.ng, after.unknown]).toEqual([before.ok + 1, before.ng, before.unknown - 1]);
    expect(formbarText("done", after)).toBe("選択 4 件 → 成功 2・失敗 0・結果不明 2");
    // 失敗に替えた行は、失敗・結果不明と同じ並び（先頭）のまま、選んだ順に並ぶ
    const ng = resolveItem(list, 5, "failed");
    expect(ng[4]).toMatchObject({ state: "ng", reason: RESOLVED_NOTE });
    expect(sortForList(ng).map((i) => i.name)).toEqual(["b", "c", "d", "e", "a"]);
    // 確認できない行・ほかの行には何も起こらない
    expect(resolveItem(list, 3, "success")).toEqual(list);
    expect(resolveItem(list, 1, "failed")).toEqual(list);
    // 結果不明の行がなくなれば、知らせは結果不明の文を持たない（成功だけなら ok）
    const solved = resolveItem(resolveItem(items([{ name: "a", state: "ok" }, { name: "b", state: "uk", resolve: target }, { name: "e", state: "uk", resolve: target }]), 2, "success"), 3, "success");
    expect(countItems(solved).unknown).toBe(0);
    expect(resultNotice(countItems(solved), "")).toMatchObject({ kind: "ok", alert: false });
  });

  it("結果不明を確認して記録したときの読み上げと、次に確認する行", () => {
    expect(resolvedMessage("IM0007", "success", 1)).toBe("IM0007 を成功として記録しました。結果不明 1 件。");
    expect(resolvedMessage("IM0007", "failed", 0)).toBe("IM0007 を失敗として記録しました。");
    const target = { requestId: "0b7d9c1e-2f3a-4b5c-9d6e-1f2a3b4c5d6e", studyInstanceUid: "1.2.3" };
    const list = items([{ name: "a", state: "uk", resolve: target }, { name: "b", state: "ok" }, { name: "c", state: "uk", resolve: target }, { name: "d", state: "uk" }]);
    // 並びの順で、今の行の後ろ。最後なら先頭から。ほかに無ければ null
    expect(nextResolvable(list, 1)?.name).toBe("c");
    expect(nextResolvable(list, 3)?.name).toBe("a");
    expect(nextResolvable(items([{ name: "a", state: "uk", resolve: target }]), 1)).toBeNull();
    expect(nextResolvable(items([{ name: "a" }]), 1)).toBeNull();
  });

  it("シリーズ／画像：S2 / I15。片方だけ読めないときは —、両方とも無ければ空", () => {
    const tags = { patientId: "", patientName: "", studyDate: "", modality: "" };
    expect(seriesImageText({ ...tags, seriesNumber: "2", instanceNumber: "15" })).toBe("S2 / I15");
    expect(seriesImageText({ ...tags, seriesNumber: "2", instanceNumber: "" })).toBe("S2 / I—");
    expect(seriesImageText({ ...tags, seriesNumber: "", instanceNumber: "" })).toBe("");
    expect(seriesImageText(null)).toBe("");
  });
});

describe("部品の形（何も選んでいないとき）", () => {
  const html = renderToStaticMarkup(createElement(FilePicker, { limitBytes: 256 * MB, importFile: async () => ({ ok: true as const }) }));

  it("見出し「インポート」・取り込み口の 1 行・2 つの選ぶボタン・操作の行の理由と押せない主ボタン", () => {
    expect(html).toMatch(/<h2[^>]*>インポート<\/h2>/);
    expect(html).toContain("ここにファイルまたはフォルダをドロップ");
    expect(html).toContain(">ファイルを選択<");
    expect(html).toContain(">フォルダを選択<");
    expect(html).toContain("ファイルを選択してください。");
    expect(html).toMatch(/<button[^>]*data-pk="go"[^>]*disabled=""/);
    // 何も選んでいないときは取り込み口だけを大きく（compact でない）
    expect(html).not.toContain("compact");
    expect(html).toContain('data-over="false"');
  });

  it("隠した input は Tab の止まり先にせず、hidden 属性ではなく class で隠す。読み上げの領域は status", () => {
    expect(html.match(/<input[^>]*type="file"[^>]*>/g)).toHaveLength(2);
    for (const input of html.match(/<input[^>]*>/g)!) {
      expect(input).toContain('tabindex="-1"');
      expect(input).not.toMatch(/\shidden(=|\s|>)/);
    }
    expect(html).toMatch(/<p class="sr-only" role="status"/);
  });

  it("説明の文を置かない（取り込み口の 1 行と操作の行の 1 行のほかに文が無い）", () => {
    expect(html).not.toMatch(/<p(?![^>]*role="status")[^>]*>[^<]+<\/p>/);
  });
});
