import { BackendError, type Backend } from "@/lib/backend/types";

// 中継の path（docs/spec.md の 3.2・原則 8）。
// 中継はビューアが画像を取る道（WADO-RS の読み取り）だけで、検索（QIDO-RS）と書き込み（STOW-RS など）は通さない。
// 検索は画面の API（役割ごとの許可の一覧の対象）を使う。

// 使える字。`..`・空の段・制御文字・`/`・`%` を断る。`,` はフレームの番号の並び（frames/1,2,3）のため。
// どれも URL の path にそのまま書ける字なので、符号化しない
const SEGMENT = /^[A-Za-z0-9.,_-]+$/;

/** 中継の path の字を確かめて、`/` でつなぐ。だめなら 400 */
export function safeRelayPath(segments: string[]): string {
  if (segments.length === 0) throw new BackendError("path が空", 400);
  for (const s of segments) {
    if (s === "." || s === ".." || !SEGMENT.test(s)) throw new BackendError("path に使えない字がある", 400);
  }
  return segments.join("/");
}

/** 中継してよい WADO-RS の読み取りの宛先 */
export interface WadoRsTarget {
  /** `/dicom-web` より後ろの path（字は確かめ済み） */
  path: string;
  studyInstanceUid: string;
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
}

/** DICOM の UID（数字と `.`、64 字まで） */
const UID = /^[0-9]+(\.[0-9]+)*$/;
const isUid = (s: string | undefined): s is string => s !== undefined && s.length <= 64 && UID.test(s);
/** DICOM の UID の形（数字と `.`、64 字まで）か */
export const isDicomUid = (s: unknown): s is string => typeof s === "string" && isUid(s);
/** frames の番号の並び（1 から） */
const FRAME_LIST = /^[1-9][0-9]{0,5}(,[1-9][0-9]{0,5}){0,99}$/;
/** 大きな値（画素など）の URI の段。Orthanc は `bulk/{tag}/{番号}/{tag}…` の形 */
const BULK_SEGMENT = /^([0-9A-Fa-f]{8}|[0-9]{1,6})$/;
const RENDITIONS = new Set(["metadata", "rendered", "thumbnail"]);
const FRAME_RENDITIONS = new Set(["rendered", "thumbnail"]);

/**
 * WADO-RS の読み取り（検査・シリーズ・画像の取得、metadata・rendered・thumbnail・frames・bulk）なら宛先を返す。
 * 検索（`studies`・`studies/{uid}/series`・`…/instances` など）やほかの path は null。
 * 字が使えない path は 400 を投げる。
 */
export function wadoRsTarget(segments: string[]): WadoRsTarget | null {
  const path = safeRelayPath(segments);
  const [studies, study, ...rest] = segments;
  if (studies !== "studies" || !isUid(study)) return null;
  const target: WadoRsTarget = { path, studyInstanceUid: study };

  // studies/{study}[/metadata|rendered|thumbnail]
  if (rest.length === 0) return target;
  if (rest.length === 1) return RENDITIONS.has(rest[0]!) ? target : null;

  // …/series/{series}[/metadata|rendered|thumbnail]
  const [seriesWord, series, ...afterSeries] = rest;
  if (seriesWord !== "series" || !isUid(series)) return null;
  target.seriesInstanceUid = series;
  if (afterSeries.length === 0) return target;
  if (afterSeries.length === 1) return RENDITIONS.has(afterSeries[0]!) ? target : null;

  // …/instances/{instance}[/metadata|rendered|thumbnail]
  const [instancesWord, instance, ...afterInstance] = afterSeries;
  if (instancesWord !== "instances" || !isUid(instance)) return null;
  target.sopInstanceUid = instance;
  if (afterInstance.length === 0) return target;
  if (afterInstance.length === 1) return RENDITIONS.has(afterInstance[0]!) ? target : null;

  // …/frames/{list}[/rendered|thumbnail]、…/bulk/{tag}…
  const [kind, ...more] = afterInstance;
  if (kind === "frames") {
    const [list, rendition, ...extra] = more;
    if (!list || !FRAME_LIST.test(list) || extra.length > 0) return null;
    if (rendition !== undefined && !FRAME_RENDITIONS.has(rendition)) return null;
    return target;
  }
  if (kind === "bulk") {
    return more.length >= 1 && more.length <= 8 && more.every((s) => BULK_SEGMENT.test(s)) ? target : null;
  }
  return null;
}

/** 画像の表現（`thumbnail`・`rendered`）を求める path か（最後の段で決める。frames/1/rendered も含む） */
export function isImageRendition(path: string): boolean {
  const last = path.split("/").at(-1);
  return last === "thumbnail" || last === "rendered";
}

/** Accept の中で、q が 0 より大きい形で名指しされている media type か（ワイルドカードの範囲指定は名指しにしない） */
function namesMediaType(accept: string, type: string): boolean {
  return accept.split(",").some((part) => {
    const [name, ...params] = part.split(";").map((s) => s.trim().toLowerCase());
    if (name !== type) return false;
    const q = params.find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/**
 * 画像サーバーへ渡す Accept を決める（docs/spec.md の 3.2）。
 * `thumbnail`・`rendered` は BFF が決める：既定は `image/jpeg`、ブラウザが `image/png` を名指しし、`image/jpeg` を名指ししていないときだけ `image/png`。
 * ブラウザの `<img>` の Accept（`image/avif,…` のあとにワイルドカードの範囲が続く形）をそのまま渡すと、Orthanc の DICOMweb のプラグインは 400（Unsupported MIME type）を返す。
 * それ以外（metadata・frames・bulk など、ビューアの取得）は、ブラウザの Accept をそのまま渡す（無ければ付けない）。
 */
export function relayAccept(path: string, browserAccept: string | null | undefined): string | undefined {
  if (!isImageRendition(path)) return browserAccept || undefined;
  const accept = browserAccept ?? "";
  return namesMediaType(accept, "image/png") && !namesMediaType(accept, "image/jpeg") ? "image/png" : "image/jpeg";
}

/** 中継の Accept を relayAccept で決めてから渡す Backend にする（モックを実の接続と同じ決め方にする） */
export function withRelayAccept(backend: Backend): Backend {
  return {
    ...backend,
    relayDicomweb: (req) => backend.relayDicomweb({ ...req, accept: relayAccept(req.target.path, req.accept) ?? null }),
  };
}

/** 画像サーバー（モック）が `thumbnail`・`rendered` で受ける Accept か（`image/jpeg`・`image/png` のどちらかだけ。無ければ受ける） */
export function isAcceptableImageAccept(accept: string | null | undefined): boolean {
  if (!accept) return true;
  return accept === "image/jpeg" || accept === "image/png";
}
