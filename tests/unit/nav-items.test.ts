import { describe, expect, it } from "vitest";
import { buildNavGroups, isCurrent } from "@/components/layout/nav-items";

// 左のナビの項目（docs/design-system/menu.md）：項目の名前は用語集の語。役割に許された頁だけを出し、空の群は出さない。

const labels = (groups: ReturnType<typeof buildNavGroups>) => groups.map((g) => [g.label, g.items.map((i) => i.label)]);

describe("左のナビの項目", () => {
  it("管理者：業務・送受信・管理の 3 群に、用語集の語で並ぶ（群の名前と項目名で同じ語を重ねない）", () => {
    const groups = buildNavGroups({
      canManageUsers: true,
      canEditViewerDefaults: true,
      account: true,
      canViewReceived: true,
      canViewSent: true,
      canCheckModalities: true,
    });
    expect(labels(groups)).toEqual([
      ["業務", ["検査一覧"]],
      ["送受信", ["受信一覧", "送信一覧", "接続先"]],
      ["管理", ["ビューア設定", "ユーザー管理", "個人設定", "バージョン情報"]],
    ]);
    const groupLabels = groups.map((g) => g.label);
    for (const item of groups.flatMap((g) => g.items)) expect(groupLabels).not.toContain(item.label);
  });

  it("バージョン情報は、役割に関わらず管理の群の最後に出る", () => {
    const groups = buildNavGroups({ canManageUsers: false, canEditViewerDefaults: false, account: false });
    expect(labels(groups)).toEqual([
      ["業務", ["検査一覧"]],
      ["管理", ["バージョン情報"]],
    ]);
    expect(groups[1]!.items.at(-1)).toMatchObject({ href: "/version", icon: "version" });
  });

  it("一般：許された頁だけを出し、項目の無い群は出さない", () => {
    const groups = buildNavGroups({ canManageUsers: false, canEditViewerDefaults: false, account: false });
    expect(labels(groups)).toEqual([
      ["業務", ["検査一覧"]],
      ["管理", ["バージョン情報"]],
    ]);
    const withAccount = buildNavGroups({ canManageUsers: false, canEditViewerDefaults: false, account: true, canViewReceived: true });
    expect(labels(withAccount)).toEqual([
      ["業務", ["検査一覧"]],
      ["送受信", ["受信一覧"]],
      ["管理", ["個人設定", "バージョン情報"]],
    ]);
    // 送信一覧は、send.view の役割にだけ出す（受信一覧の下）
    const withSent = buildNavGroups({ canManageUsers: false, canEditViewerDefaults: false, account: false, canViewReceived: true, canViewSent: true });
    expect(labels(withSent)[1]).toEqual(["送受信", ["受信一覧", "送信一覧"]]);
    expect(withSent[1]!.items.at(-1)).toMatchObject({ href: "/sent", icon: "sent" });
  });

  it("インポート（段 6）：許されたときだけ、業務の群の最後に出る（送受信の群には入れない）", () => {
    const base = { canManageUsers: false, canEditViewerDefaults: false, account: false, canViewReceived: true, canViewSent: true };
    const withImport = buildNavGroups({ ...base, canImport: true });
    expect(labels(withImport)[0]).toEqual(["業務", ["検査一覧", "インポート"]]);
    expect(labels(withImport)[1]).toEqual(["送受信", ["受信一覧", "送信一覧"]]);
    expect(withImport[0]!.items.at(-1)).toMatchObject({ href: "/import", icon: "import" });
    expect(labels(buildNavGroups(base))[0]).toEqual(["業務", ["検査一覧"]]);
  });

  it("今いる頁：検査一覧（/）は完全に一致したときだけ、ほかは下の道も含める", () => {
    expect(isCurrent("/", "/")).toBe(true);
    expect(isCurrent("/received", "/")).toBe(false);
    expect(isCurrent("/admin/users", "/admin/users")).toBe(true);
    expect(isCurrent("/admin/users/abc", "/admin/users")).toBe(true);
    expect(isCurrent("/admin/usersX", "/admin/users")).toBe(false);
  });
});
