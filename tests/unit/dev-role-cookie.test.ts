import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeDevRole, encodeDevRole } from "@/lib/auth/dev-role-cookie";

const SECRET = "s".repeat(48);

describe("検証モードの役割の cookie", () => {
  it("署名した役割を読み戻す", () => {
    expect(decodeDevRole(encodeDevRole("general", SECRET), SECRET)).toBe("general");
  });

  it("役割を書き換えた cookie は使わない", () => {
    const value = encodeDevRole("general", SECRET);
    expect(decodeDevRole(value.replace(/^general/, "admin"), SECRET)).toBeNull();
  });

  it("前の役割の名前（医師・技師・閲覧）で正しく署名した cookie は、役割を選んでいない扱いにする（docs/spec.md の 3.6）", () => {
    for (const old of ["doctor", "technologist", "viewer"]) {
      const sig = createHmac("sha256", SECRET).update(`dev-role:${old}`).digest("base64url");
      expect(decodeDevRole(`${old}.${sig}`, SECRET)).toBeNull();
    }
  });

  it("ほかの SESSION_SECRET で署名した cookie は使わない", () => {
    expect(decodeDevRole(encodeDevRole("admin", SECRET), "t".repeat(48))).toBeNull();
  });

  it("形の崩れた値は使わない", () => {
    for (const v of [undefined, "", "admin", "root.abc", "admin."]) expect(decodeDevRole(v, SECRET)).toBeNull();
  });
});
