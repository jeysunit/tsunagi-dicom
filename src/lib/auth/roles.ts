// 役割（docs/spec.md の 3.6）。役割ごとにできる操作の割り当ては段 1b で決める。
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
