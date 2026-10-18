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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type PermissionMap = Record<Role, readonly Permission[]>;

export const ROLE_PERMISSIONS: PermissionMap = {
  admin: ["study.search", "image.retrieve", "dicom.all_values", "audit.verify", "user.manage"],
  doctor: ["study.search", "image.retrieve"],
  technologist: ["study.search", "image.retrieve", "dicom.all_values"],
  viewer: ["study.search", "image.retrieve"],
};

export function can(role: Role, permission: Permission, map: PermissionMap = ROLE_PERMISSIONS): boolean {
  return map[role]?.includes(permission) ?? false;
}
