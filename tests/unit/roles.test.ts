import { describe, expect, it } from "vitest";
import { can, PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Permission, type Role } from "@/lib/auth/roles";

// 役割ごとにできる操作（docs/spec.md の 3.6、第7.0版 14.2）。段 1b の割り当てを表のとおりに確かめる。

const EXPECTED: Record<Role, Permission[]> = {
  admin: ["study.search", "image.retrieve", "dicom.all_values", "audit.verify", "user.manage"],
  doctor: ["study.search", "image.retrieve"],
  technologist: ["study.search", "image.retrieve", "dicom.all_values"],
  viewer: ["study.search", "image.retrieve"],
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

  it("割り当てに無い操作・役割はできない側に倒れる", () => {
    const empty = { admin: [], doctor: [], technologist: [], viewer: [] };
    for (const role of ROLES) for (const p of PERMISSIONS) expect(can(role, p, empty)).toBe(false);
    expect(can("nurse" as Role, "study.search")).toBe(false);
  });

  it("割り当ての表は、決めた操作だけを持つ", () => {
    for (const role of ROLES) for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
  });
});
