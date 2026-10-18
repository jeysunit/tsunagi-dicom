import { describe, expect, it } from "vitest";
import { openField, sealField } from "@/lib/auth/sealed-field";

// データベースに置く TOTP の秘密の暗号化（AES-256-GCM。鍵は SESSION_SECRET から HKDF で導く）。

const KEY = "k".repeat(48);

describe("TOTP の秘密の暗号化", () => {
  it("同じ鍵と aad で戻せ、平文を含まない", () => {
    const sealed = sealField("JBSWY3DPEHPK3PXP", KEY, "user-1");
    expect(sealed).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(openField(sealed, KEY, "user-1")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("毎回ちがう値になる（iv が違う）", () => {
    expect(sealField("JBSWY3DPEHPK3PXP", KEY, "user-1")).not.toBe(sealField("JBSWY3DPEHPK3PXP", KEY, "user-1"));
  });

  it("鍵（SESSION_SECRET）が違えば戻せない", () => {
    const sealed = sealField("JBSWY3DPEHPK3PXP", KEY, "user-1");
    expect(openField(sealed, "z".repeat(48), "user-1")).toBeNull();
  });

  it("ほかの利用者の行へ写した値は戻せない（aad が違う）", () => {
    const sealed = sealField("JBSWY3DPEHPK3PXP", KEY, "user-1");
    expect(openField(sealed, KEY, "user-2")).toBeNull();
  });

  it("書き換えた値・形の崩れた値は戻せない", () => {
    const sealed = sealField("JBSWY3DPEHPK3PXP", KEY, "user-1");
    const parts = sealed.split(":");
    // 末尾の字は使わない bit を含むことがあるので、頭の字を替える
    parts[2] = (parts[2]!.startsWith("A") ? "B" : "A") + parts[2]!.slice(1);
    expect(openField(parts.join(":"), KEY, "user-1")).toBeNull();
    expect(openField("v2:a:b:c", KEY, "user-1")).toBeNull();
    expect(openField("garbage", KEY, "user-1")).toBeNull();
  });
});
