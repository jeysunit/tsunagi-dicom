import { describe, expect, it } from "vitest";
import { can, PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Permission, type Role } from "@/lib/auth/roles";

// 役割ごとにできる操作（docs/spec.md の 3.6、第7.0版 14.2）。段 1b の割り当てを表のとおりに確かめる。

const STATE_ALL = ["study.inspect", "study.read_status", "study.urgent", "study.bookmark"] as const;
const EXPECTED: Record<Role, Permission[]> = {
  admin: ["study.search", "image.retrieve", "dicom.all_values", "audit.verify", "user.manage", ...STATE_ALL, "viewer.remember", "viewer.defaults"],
  doctor: ["study.search", "image.retrieve", "study.read_status", "study.urgent", "study.bookmark", "viewer.remember"],
  technologist: ["study.search", "image.retrieve", "dicom.all_values", "study.inspect", "study.urgent", "study.bookmark", "viewer.remember"],
  viewer: ["study.search", "image.retrieve", "study.bookmark"],
};

describe("役割ごとにできる操作", () => {
  for (const role of ROLES) {
    for (const permission of PERMISSIONS) {
      const allowed = EXPECTED[role].includes(permission);
      it(`${role} は ${permission} が${allowed ? "できる" : "できない"}`, () => {
        expect(can(role, permission)).toBe(allowed);
      });
    }
  }

  it("利用者の管理と監査の確かめは管理者だけ", () => {
    expect(ROLES.filter((r) => can(r, "user.manage"))).toEqual(["admin"]);
    expect(ROLES.filter((r) => can(r, "audit.verify"))).toEqual(["admin"]);
  });

  it("すべての DICOM の値を見る権限は、既定では管理者と技師（docs/spec.md 原則 8）", () => {
    expect(ROLES.filter((r) => can(r, "dicom.all_values"))).toEqual(["admin", "technologist"]);
  });

  it("段 2：検像は管理者と技師、読影の状態は管理者と医師、モダリティの既定のビューアは管理者だけ", () => {
    expect(ROLES.filter((r) => can(r, "study.inspect"))).toEqual(["admin", "technologist"]);
    expect(ROLES.filter((r) => can(r, "study.read_status"))).toEqual(["admin", "doctor"]);
    expect(ROLES.filter((r) => can(r, "viewer.defaults"))).toEqual(["admin"]);
    // 閲覧が変えられるのは、自分のブックマークだけ
    expect(PERMISSIONS.filter((p) => can("viewer", p))).toEqual(["study.search", "image.retrieve", "study.bookmark"]);
  });

  it("割り当てに無い操作・役割はできない側に倒れる", () => {
    const empty = { admin: [], doctor: [], technologist: [], viewer: [] };
    for (const role of ROLES) for (const p of PERMISSIONS) expect(can(role, p, empty)).toBe(false);
    expect(can("nurse" as Role, "study.search")).toBe(false);
  });

  it("割り当ての表は、決めた操作だけを持つ", () => {
    for (const role of ROLES) for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
  });
});
