// 役割と、役割ごとにできる操作（docs/spec.md の 3.6、第7.0版 14.2）。
// 操作は、この段までに道がある操作だけを並べる。後の段で道を足すときは、ここに操作を足して割り当て、試験を付ける。
// 割り当てに無い操作は「できない」側に倒れる。AUTH_MODE=dev の検証モードで選んだ役割にも、同じ割り当てを当てる。
export const ROLES = ["admin", "doctor", "technologist", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "管理者",
  doctor: "医師",
  technologist: "技師",
  viewer: "閲覧",
};

/** 検証モードで役割を選んでいないときは、いちばん狭い「閲覧」にする */
export const DEFAULT_DEV_ROLE: Role = "viewer";

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export const PERMISSIONS = [
  // 検査の検索（画面の API・検査の一覧の頁）
  "study.search",
  // ビューアが画像を取る道（BFF の中継の WADO-RS の読み取り）
  "image.retrieve",
  // すべての DICOM の値を見る（docs/spec.md 原則 8。画面は段 2）
  "dicom.all_values",
  // 監査の記録のつなぎの確かめ（/api/audit/verify）
  "audit.verify",
  // 利用者の管理（一覧・作る・役割・止める・TOTP のやり直し・一時停止の解除）
  "user.manage",
  // 段 2：検査ごとの既定のビューアを覚える（ほかの利用者にも効く。BFF のデータベースだけを変える）。
  // 段 2 の検査の状態の印の操作（検像・読影の状態・緊急の印・ブックマーク）は段 3 で外した
  "viewer.remember",
  // モダリティごとの既定のビューアを変える（管理の画面）
  "viewer.defaults",
  // 段 4（docs/spec.md の 3.3・3.4。割り当ては推奨の案で、承認者の判断の前）
  // 受け取りの記録を見る（Orthanc の変更の記録から読む）
  "receive.view",
  // 機器の一覧（名前と AE タイトル。住所は許可の一覧の modality で絞る）と、つながるかの確かめ（C-ECHO）
  "modality.check",
  // ほかの機器へ送る（書き込みの操作。docs/spec.md の 3.5 の共通の決まりを通す）
  "study.send",
  // 結果の分からない書き込みの操作を、管理者が確かめて記録に足す（照らし合わせ。docs/spec.md の 3.5）
  "pacs.reconcile",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type PermissionMap = Record<Role, readonly Permission[]>;

export const ROLE_PERMISSIONS: PermissionMap = {
  admin: [
    "study.search",
    "image.retrieve",
    "dicom.all_values",
    "audit.verify",
    "user.manage",
    "viewer.remember",
    "viewer.defaults",
    "receive.view",
    "modality.check",
    "study.send",
    "pacs.reconcile",
  ],
  doctor: ["study.search", "image.retrieve", "viewer.remember"],
  technologist: [
    "study.search",
    "image.retrieve",
    "dicom.all_values",
    "viewer.remember",
    "receive.view",
    "modality.check",
    "study.send",
  ],
  viewer: ["study.search", "image.retrieve"],
};

export function can(role: Role, permission: Permission, map: PermissionMap = ROLE_PERMISSIONS): boolean {
  return map[role]?.includes(permission) ?? false;
}
