import { describe, expect, it } from "vitest";
import { can, DEFAULT_DEV_ROLE, isRole, PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, ROLES, type Permission, type Role } from "@/lib/auth/roles";

// 役割ごとにできる操作（docs/spec.md の 3.6、第7.0版 14.2）。役割は管理者と一般の2つ（2026-10-20 に承認者が決めた）。
// 前の医師・技師・閲覧の役割の割り当ての試験は、役割そのものを無くしたので外し、一般の割り当ての試験に替えた。

// 一般：普段使う機能の全部（一覧・詳細・ビューア・受信一覧・接続確認・送信・エクスポート・DICOM タグ・ビューアの覚え）
const GENERAL: Permission[] = [
  "study.search",
  "image.retrieve",
  "dicom.all_values",
  "viewer.remember",
  "receive.view",
  "modality.check",
  "study.send",
  "study.export",
];
const EXPECTED: Record<Role, Permission[]> = {
  // 管理者：一般の全部に加えて、削除・ユーザー管理・システムの設定・照らし合わせ・監査の確かめ
  admin: [...GENERAL, "audit.verify", "user.manage", "viewer.defaults", "pacs.reconcile", "study.delete"],
  general: GENERAL,
};

describe("役割ごとにできる操作", () => {
  it("役割は管理者と一般の2つだけ。閲覧だけの役割は無い", () => {
    expect([...ROLES]).toEqual(["admin", "general"]);
    expect(ROLE_LABELS).toEqual({ admin: "管理者", general: "一般" });
    for (const removed of ["doctor", "technologist", "viewer"]) expect(isRole(removed)).toBe(false);
  });

  for (const role of ROLES) {
    for (const permission of PERMISSIONS) {
      const allowed = EXPECTED[role].includes(permission);
      it(`${role} は ${permission} が${allowed ? "できる" : "できない"}`, () => {
        expect(can(role, permission)).toBe(allowed);
      });
    }
  }

  it("管理者は一般の全部ができる", () => {
    for (const p of ROLE_PERMISSIONS.general) expect(can("admin", p)).toBe(true);
  });

  it("削除・ユーザー管理・システムの設定・照らし合わせ・監査の確かめは管理者だけ", () => {
    for (const p of ["study.delete", "user.manage", "viewer.defaults", "pacs.reconcile", "audit.verify"] as const) {
      expect(ROLES.filter((r) => can(r, p)), p).toEqual(["admin"]);
    }
  });

  it("DICOM タグ（すべての DICOM の値）は、既定では管理者と一般の両方（docs/spec.md 原則 8）", () => {
    expect(ROLES.filter((r) => can(r, "dicom.all_values"))).toEqual(["admin", "general"]);
  });

  it("検証モードで役割を選んでいないときは、狭いほうの一般", () => {
    expect(DEFAULT_DEV_ROLE).toBe("general");
    expect(PERMISSIONS.filter((p) => can(DEFAULT_DEV_ROLE, p)).length).toBeLessThan(PERMISSIONS.filter((p) => can("admin", p)).length);
  });

  it("段 3：検査の状態の印の操作は、どの役割にも無い（操作そのものを外した）", () => {
    for (const removed of ["study.inspect", "study.read_status", "study.urgent", "study.bookmark"]) {
      expect(PERMISSIONS as readonly string[]).not.toContain(removed);
    }
  });

  it("割り当てに無い操作・役割はできない側に倒れる", () => {
    const empty = { admin: [], general: [] };
    for (const role of ROLES) for (const p of PERMISSIONS) expect(can(role, p, empty)).toBe(false);
    expect(can("nurse" as Role, "study.search")).toBe(false);
    expect(can("viewer" as Role, "study.search")).toBe(false);
  });

  it("割り当ての表は、決めた操作だけを持つ", () => {
    for (const role of ROLES) for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
  });
});
