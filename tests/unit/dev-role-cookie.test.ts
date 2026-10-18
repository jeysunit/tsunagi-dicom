import { describe, expect, it } from "vitest";
import { decodeDevRole, encodeDevRole } from "@/lib/auth/dev-role-cookie";

const SECRET = "s".repeat(48);

describe("検証モードの役割の cookie", () => {
  it("署名した役割を読み戻す", () => {
    expect(decodeDevRole(encodeDevRole("doctor", SECRET), SECRET)).toBe("doctor");
  });

  it("役割を書き換えた cookie は使わない", () => {
    const value = encodeDevRole("viewer", SECRET);
    expect(decodeDevRole(value.replace(/^viewer/, "admin"), SECRET)).toBeNull();
  });

  it("ほかの SESSION_SECRET で署名した cookie は使わない", () => {
    expect(decodeDevRole(encodeDevRole("admin", SECRET), "t".repeat(48))).toBeNull();
  });

  it("形の崩れた値は使わない", () => {
    for (const v of [undefined, "", "admin", "root.abc", "admin."]) expect(decodeDevRole(v, SECRET)).toBeNull();
  });
});
