import Link from "next/link";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// 空の状態（docs/design-system/parts.md の「知らせ・空の状態」）。1 行目に事実、2 行目に次の手、操作は 1 つまで。内側 32px。
// 表の枠と見出しの行は、呼ぶ側が出したままにする。読み込みに失敗したときは使わず、知らせ（notice）の誤りを使う。
// denied は権限の無い頁の型。黙って別の頁へ移さず、この型で事実と次の手を出す。
type EmptyStateProps = {
  /** 1 行目：事実（「条件に合う検査はありません。」） */
  fact: string;
  /** 2 行目：次の手 */
  next?: string;
  /** 操作は 1 つまで */
  action?: React.ReactNode;
  kind?: "empty";
} & Omit<React.ComponentProps<"div">, "children">;

type DeniedStateProps = {
  kind: "denied";
  /** 既定は管理者だけが開ける頁。役割の組み合わせが別の頁は false にして、事実を「権限が無い」にする */
  adminOnly?: boolean;
} & Omit<React.ComponentProps<"div">, "children">;

export function EmptyState(props: EmptyStateProps | DeniedStateProps) {
  if (props.kind === "denied") {
    const { kind: _kind, adminOnly = true, className, ...rest } = props;
    return (
      <Box className={className} data-kind="denied" role="status" {...rest}>
        <b className="text-value">{adminOnly ? "この画面は管理者のみ利用できます。" : "この画面を開く権限がありません。"}</b>
        <span className="text-label">管理者に役割の変更を頼んでください。</span>
        <Button asChild variant="outline">
          <Link href="/">検査一覧へ</Link>
        </Button>
      </Box>
    );
  }
  const { kind: _kind, fact, next, action, className, ...rest } = props;
  return (
    <Box className={className} {...rest}>
      <b className="text-value">{fact}</b>
      {next && <span className="text-label">{next}</span>}
      {action}
    </Box>
  );
}

// 部品集の `.empty`：中央寄せの点線の枠（枠 1px border-input・角 6px・内 32px 16px・間 8px・字 label）。権限の無い頁（denied）は実線
function Box({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center gap-2 rounded-md border border-dashed border-border-input px-4 py-8 text-center text-label data-[kind=denied]:border-solid",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
