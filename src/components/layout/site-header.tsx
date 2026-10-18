import { ShieldAlert } from "lucide-react";
import Link from "next/link";

// どの頁にも出す見出し。「非医療機器」の表示はここに1つだけ置く（機能ごとの断り書きは足さない）。
export function SiteHeader() {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-border bg-surface px-4 py-2">
      <Link href="/" className="font-bold text-value">
        tsunagi-dicom
      </Link>
      <p className="flex items-center gap-1.5 text-label" data-testid="not-for-diagnostic-use">
        <ShieldAlert aria-hidden className="size-4" />
        Not for Diagnostic Use / 非医療機器
      </p>
    </header>
  );
}
