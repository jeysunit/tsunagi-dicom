// 画像ごとの「主なタグ」（docs/spec.md の 3.1）。出すタグの一覧（INSTANCE_TAGS）の読み方と、既定の一覧、タグ名の表。
// タグは 8 桁の大文字の 16 進（`00080018`）で持つ。画面に出すときは `0008,0018` の形にする。

/** 既定の一覧（INSTANCE_TAGS が空・未設定のとき）。画像の確認（どの画像か・いつ・位置と向き・大きさと画素・表示の値・圧縮）に普通使うもの */
export const DEFAULT_INSTANCE_TAGS = [
  "00080018",
  "00080016",
  "00200013",
  "00080008",
  "00200012",
  "00080022",
  "00080032",
  "00080023",
  "00080033",
  "00200032",
  "00200037",
  "00201041",
  "00180050",
  "00280010",
  "00280011",
  "00280030",
  "00280008",
  "00280004",
  "00280100",
  "00280101",
  "00281050",
  "00281051",
  "00281052",
  "00281053",
  "00282110",
] as const;

/** INSTANCE_TAGS に書ける数の上限 */
export const INSTANCE_TAGS_MAX = 100;

/**
 * タグ名（画面に出す日本語の名前）。既定の一覧と、患者・検査・シリーズの主なタグ。表に無いタグ（私的タグを含む）はタグ名を空にする。
 * 訳は公開の資料（リベルワークス「標準DICOM画像タグセット一覧」・Sonic DICOM「DICOM用語集」）を参考にし、
 * 画面の用語集（docs/spec.md の 2.2）にある言葉はそちらを先にする（画像番号・検査名・シリーズ名・氏名・患者ID など）。
 */
export const TAG_NAMES: Readonly<Record<string, string>> = {
  // 既定の一覧
  "00080018": "SOPインスタンスUID",
  "00080016": "SOPクラスUID",
  "00200013": "画像番号",
  "00080008": "画像タイプ",
  "00200012": "収集番号",
  "00080022": "収集日",
  "00080032": "収集時刻",
  "00080023": "画像作成日",
  "00080033": "画像作成時刻",
  "00200032": "画像位置（患者）",
  "00200037": "画像方向（患者）",
  "00201041": "スライス位置",
  "00180050": "スライス厚",
  "00280010": "行数",
  "00280011": "列数",
  "00280030": "画素間隔",
  "00280008": "フレーム数",
  "00280004": "光度測定解釈",
  "00280100": "割当ビット",
  "00280101": "格納ビット",
  "00281050": "ウィンドウ中心",
  "00281051": "ウィンドウ幅",
  "00281052": "リスケール切片",
  "00281053": "リスケール傾き",
  "00282110": "非可逆画像圧縮",
  // 患者・検査・シリーズの主なタグと、画素の形
  "00020010": "転送構文UID",
  "00080005": "特定文字集合",
  "00080020": "検査日",
  "00080030": "検査時刻",
  "00080021": "シリーズ日",
  "00080031": "シリーズ時刻",
  "00080050": "受付番号",
  "00080060": "モダリティ",
  "00080070": "製造者",
  "00080080": "施設名",
  "00080090": "紹介医",
  "00081030": "検査名",
  "0008103E": "シリーズ名",
  "00081090": "製造者のモデル名",
  "00100010": "氏名",
  "00100020": "患者ID",
  "00100030": "生年月日",
  "00100040": "性別",
  "00180015": "検査部位",
  "00180060": "管電圧",
  "00180088": "スライス間隔",
  "0020000D": "検査インスタンスUID",
  "0020000E": "シリーズインスタンスUID",
  "00200010": "Study ID",
  "00200011": "シリーズ番号",
  "00200020": "患者方向",
  "00200052": "基準座標系UID",
  "00280002": "画素あたりサンプル",
  "00280102": "高位ビット",
  "00280103": "画素表現",
  "7FE00010": "画素データ",
};

/** タグ名。表に無ければ空 */
export function tagName(tag: string): string {
  return TAG_NAMES[tag.replace(",", "").toUpperCase()] ?? "";
}

const TOKEN = /^\(?([0-9A-Fa-f]{4}),?([0-9A-Fa-f]{4})\)?$/;

export type InstanceTagsResult = { ok: true; tags: string[] } | { ok: false; message: string };

/**
 * INSTANCE_TAGS の値を読む。番号を空白で区切り、1 つの番号は `(gggg,eeee)`・`gggg,eeee`・`ggggeeee` のどれでもよい
 * （16 進の大文字と小文字は区別しない）。空なら既定の一覧。形の誤り・重なり・上限を超える数は誤り（誤った番号を示す。秘密ではない）
 */
export function parseInstanceTags(value: string | undefined): InstanceTagsResult {
  const tokens = (value ?? "").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ok: true, tags: [...DEFAULT_INSTANCE_TAGS] };
  const bad = tokens.filter((t) => {
    const m = TOKEN.exec(t);
    // 括弧は両側にそろえる。4 桁と 4 桁の間の `,` は、括弧のときは必須
    return !m || t.startsWith("(") !== t.endsWith(")") || (t.startsWith("(") && !t.includes(","));
  });
  if (bad.length > 0) return { ok: false, message: `タグの番号の形が誤り：${bad.join(" ")}（(0008,0018)・0008,0018・00080018 の形で、空白で区切る）` };
  const tags = tokens.map((t) => {
    const m = TOKEN.exec(t)!;
    return `${m[1]}${m[2]}`.toUpperCase();
  });
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const t of tags) (seen.has(t) ? dup : seen).add(t);
  if (dup.size > 0) return { ok: false, message: `同じタグが重なっている：${[...dup].map(displayTag).join(" ")}` };
  if (tags.length > INSTANCE_TAGS_MAX) return { ok: false, message: `${INSTANCE_TAGS_MAX} 個までにする（${tags.length} 個ある）` };
  return { ok: true, tags };
}

/** `00080018` を `0008,0018` に */
export function displayTag(tag: string): string {
  return `${tag.slice(0, 4)},${tag.slice(4)}`;
}
