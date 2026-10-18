import type { AppConfig } from "@/lib/config";
import type { ModalityGroup } from "@/lib/modalities";

// ビューアの部品（ViewerAdapter。docs/spec.md の 3.2）。設定で URL が与えられたものだけを出す。
// ビューアは BFF の中継（/api/dicom-web）から画像を取るように、ビューアの側で設定する（中継の住所はビューアの設定）。
// ここでは、検査を開く URL だけを作る。Weasis（weasis://）は段 4 の後なので、まだ出さない。

export const VIEWER_IDS = ["ohif", "stone", "volview", "dicomweb"] as const;
export type ViewerId = (typeof VIEWER_IDS)[number];

export const VIEWER_LABELS: Record<ViewerId, string> = {
  ohif: "OHIF",
  stone: "Stone",
  volview: "VolView",
  dicomweb: "DICOMweb の URL",
};

export function isViewerId(value: unknown): value is ViewerId {
  return typeof value === "string" && (VIEWER_IDS as readonly string[]).includes(value);
}

export interface ViewerInfo {
  id: ViewerId;
  label: string;
  /** dicomweb：開くのではなく URL をコピーする（このアプリの監査の外） */
  kind: "open" | "copy";
}

/** 設定に URL があるビューア（ブラウザに渡してよい情報だけ。URL そのものは開く時に BFF が作る） */
export function availableViewers(viewers: AppConfig["viewers"]): ViewerInfo[] {
  const out: ViewerInfo[] = [];
  if (viewers.ohifUrl) out.push({ id: "ohif", label: VIEWER_LABELS.ohif, kind: "open" });
  if (viewers.stoneUrl) out.push({ id: "stone", label: VIEWER_LABELS.stone, kind: "open" });
  if (viewers.volviewUrl) out.push({ id: "volview", label: VIEWER_LABELS.volview, kind: "open" });
  if (viewers.publicDicomwebUrl) out.push({ id: "dicomweb", label: VIEWER_LABELS.dicomweb, kind: "copy" });
  return out;
}

const trim = (url: string) => url.replace(/\/+$/, "");

/**
 * 検査を開く URL。UID は呼ぶ側で形を確かめたもの（数字と `.`）だけを渡す。設定に URL が無いビューアは null。
 * - OHIF v3：`/viewer?StudyInstanceUIDs=`
 * - Stone Web Viewer：`/index.html?study=`
 * - VolView：`?urls=[…]`（中継の WADO-RS の検査の URL を渡す。実の VolView で確かめる前の形。PR を参照）
 * - DICOMweb：研究の道具に渡す `PUBLIC_DICOMWEB_URL` の検査の URL（このアプリの監査の外）
 */
export function viewerUrl(
  id: ViewerId,
  viewers: AppConfig["viewers"],
  studyInstanceUid: string,
  relayBase: string,
): string | null {
  const uid = encodeURIComponent(studyInstanceUid);
  switch (id) {
    case "ohif":
      return viewers.ohifUrl ? `${trim(viewers.ohifUrl)}/viewer?StudyInstanceUIDs=${uid}` : null;
    case "stone":
      return viewers.stoneUrl ? `${trim(viewers.stoneUrl)}/index.html?study=${uid}` : null;
    case "volview":
      return viewers.volviewUrl
        ? `${trim(viewers.volviewUrl)}/?urls=${encodeURIComponent(`[${trim(relayBase)}/studies/${studyInstanceUid}]`)}`
        : null;
    case "dicomweb":
      return viewers.publicDicomwebUrl ? `${trim(viewers.publicDicomwebUrl)}/studies/${uid}` : null;
  }
}

/** モダリティの既定（管理の画面で変えるまでの初めの値。docs/spec.md の 3.2 の例） */
export const BUILTIN_MODALITY_DEFAULTS: Partial<Record<ModalityGroup, ViewerId>> = {
  CT: "ohif",
  MR: "ohif",
  "CR/DX": "stone",
  US: "stone",
};

/**
 * 検査を開く既定のビューア：検査ごとの覚え → モダリティの既定 → 出せるビューアの最初（開くもの）。
 * どれも出せなければ null
 */
export function resolveDefaultViewer(
  remembered: string | null | undefined,
  modalityDefault: string | null | undefined,
  available: readonly ViewerInfo[],
): ViewerId | null {
  const usable = (v: string | null | undefined): v is ViewerId =>
    isViewerId(v) && available.some((a) => a.id === v && a.kind === "open");
  if (usable(remembered)) return remembered;
  if (usable(modalityDefault)) return modalityDefault;
  return available.find((a) => a.kind === "open")?.id ?? null;
}
