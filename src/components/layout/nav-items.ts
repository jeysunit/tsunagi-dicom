// 左のナビの項目（docs/design-system/menu.md）。群は「業務」「接続」「管理」。項目の名前は docs/spec.md の 2.2 の用語集（頁の題と同じ語）。
// 出す項目は、役割に許された頁だけ。1 つも出せない群は出さない。

export type NavIcon = "studies" | "received" | "sent" | "modalities" | "viewers" | "users" | "account" | "version";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
}

export interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

export interface NavAccess {
  canManageUsers: boolean;
  canEditViewerDefaults: boolean;
  account: boolean;
  /** 受け取りの記録（段 4） */
  canViewReceived?: boolean;
  /** 送った記録（送信一覧） */
  canViewSent?: boolean;
  /** 機器の一覧と確かめ（段 4） */
  canCheckModalities?: boolean;
}

export function buildNavGroups(nav: NavAccess): NavGroup[] {
  const groups: NavGroup[] = [
    {
      label: "業務",
      items: [
        { href: "/", label: "検査一覧", icon: "studies" },
        ...(nav.canViewReceived ? [{ href: "/received", label: "受信一覧", icon: "received" as const }] : []),
        ...(nav.canViewSent ? [{ href: "/sent", label: "送信一覧", icon: "sent" as const }] : []),
      ],
    },
    {
      label: "接続",
      items: nav.canCheckModalities ? [{ href: "/modalities", label: "接続先", icon: "modalities" as const }] : [],
    },
    {
      label: "管理",
      items: [
        ...(nav.canEditViewerDefaults ? [{ href: "/admin/viewers", label: "ビューア設定", icon: "viewers" as const }] : []),
        ...(nav.canManageUsers ? [{ href: "/admin/users", label: "ユーザー管理", icon: "users" as const }] : []),
        ...(nav.account ? [{ href: "/account", label: "個人設定", icon: "account" as const }] : []),
        // 版は読むだけで秘密を含まないので、役割では絞らない（ナビを出す利用者の全員に出す）
        { href: "/version", label: "バージョン情報", icon: "version" },
      ],
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** 今いる頁か。検査の一覧（/）は完全に一致したときだけ、ほかは頁の下の道（/admin/users/… など）も含める */
export function isCurrent(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
