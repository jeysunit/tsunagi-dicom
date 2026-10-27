import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

// 一覧の表（docs/design-system/parts.md の「一覧の表（`.tbl`）」・components.md の「一覧の表」）。
// 行 28px（2 行の氏名・ボタンのある行は tall で 40px）、見出しの行 28px・地 surface・表の中のスクロールでも残す（sticky）。
// 選んだ行は地 selected-strong と最初のセルの左 3px の線（ring）・aria-selected。太字にしない（幅が変わるため）。
// 行の全体を押せ、tabindex を付けて Enter・Space で選べる。行の中のリンク・ボタン・入力は、押しても行を選ばない。
// 名前の列だけ太字（CellMain）、補足は 12px の label（CellSub）、数は右寄せ（TableCell の num）。

/**
 * 操作の列（行のボタン・リンク）を、表の右端に固定する（docs/design-system/components.md の「一覧の表」）。
 * 表が包みより広く横にスクロールするときも、操作の列は見切れない。縮めて切るのは文字の列で、操作の列は切らない。
 * 下の列が透けないよう地を塗る。地は行の地（hover の muted・選んだ行の selected-strong）にそろえる。
 * sticky のセルは重なりの文脈を作るので、行の中のメニュー（role="menu"）を開いている間だけ、そのセルを下の行の固定のセルより上に出す（z-20）
 */
export const PINNED_HEAD = "sticky right-0 bg-surface";
export const PINNED_CELL =
  "sticky right-0 bg-background has-[[role=menu]]:z-20 [tr:not([data-selected]):hover>&]:bg-muted [tr[data-selected]>&]:bg-selected-strong";

/** 行を選ぶ操作にしない部品（行の中のリンク・ボタン・入力。印を付けた部品も） */
export const ROW_CONTROL_SELECTOR = "a,button,input,select,textarea,label,summary,[role=menu],[data-row-control]";

/** 押した所が、行の中の操作の部品か（その部品の操作を、行を選ぶ操作にしない） */
export function isRowControl(target: EventTarget | null, row: Element): boolean {
  if (!target || !(target instanceof Element)) return false;
  const control = target.closest(ROW_CONTROL_SELECTOR);
  return !!control && control !== row && row.contains(control);
}

/**
 * 行の上で押したキーの意味。Space は選ぶ。Enter は、開く操作（onOpen）がある表では開き、無い表では選ぶ。
 * 行そのものにフォーカスがあるときだけ受ける（行の中のボタンの Enter・Space はそのボタンのもの）
 */
export function rowKeyAction(key: string, canOpen: boolean): "select" | "open" | null {
  if (key === " " || key === "Spacebar") return "select";
  if (key === "Enter") return canOpen ? "open" : "select";
  return null;
}

/**
 * 表の包み（`.tbl-wrap`）。表の中をスクロールさせる箱で、見出しの行はこの箱の上に残る。
 * label を渡すと、読み上げの区画（region）の名前になり、キーボードでスクロールできるよう tabindex を付ける
 */
function Table({
  className,
  wrapperClassName,
  wrapperRef,
  label,
  onWrapperScroll,
  wrapperTestId,
  overlay,
  ...props
}: React.ComponentProps<"table"> & {
  /** 表の前に、包みの中に置くもの（取り直しの待ちの細い帯など。sticky で上の縁に重ねる） */
  overlay?: React.ReactNode;
  wrapperClassName?: string;
  wrapperRef?: React.Ref<HTMLDivElement>;
  /** 区画の名前（「検査の一覧」など）。渡すと role="region" と tabindex="0" */
  label?: string;
  onWrapperScroll?: React.UIEventHandler<HTMLDivElement>;
  wrapperTestId?: string;
}) {
  return (
    <div
      ref={wrapperRef}
      data-slot="table-container"
      className={cn("tbl-wrap relative w-full overflow-auto", wrapperClassName)}
      onScroll={onWrapperScroll}
      data-testid={wrapperTestId}
      {...(label ? { role: "region", "aria-label": label, tabIndex: 0 } : {})}
    >
      {overlay}
      <table data-slot="table" className={cn("tbl w-full caption-bottom border-collapse text-sm", className)} {...props} />
    </div>
  );
}

/** 見出しの行の塊。地 surface・表の中のスクロールでも上に残る（sticky top-0） */
function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("sticky top-0 z-10 bg-surface text-left shadow-[0_1px_0_var(--color-border)]", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

/**
 * 1 行。onSelect を渡すと、選べる行になる（行の全体を押せる・Enter と Space で選ぶ・aria-selected・tabindex）。
 * onOpen を渡すと、Enter は開く操作になる（Space は選ぶまま）。tall は 2 行の氏名やボタンのある行（40px）
 */
function TableRow({
  className,
  selected,
  onSelect,
  onOpen,
  tall = false,
  onClick,
  onKeyDown,
  tabIndex,
  ...props
}: React.ComponentProps<"tr"> & {
  selected?: boolean;
  onSelect?: () => void;
  onOpen?: () => void;
  tall?: boolean;
}) {
  const selectable = onSelect !== undefined;
  return (
    <tr
      data-slot="table-row"
      data-selected={selected || undefined}
      aria-selected={selectable ? !!selected : undefined}
      tabIndex={selectable ? (tabIndex ?? 0) : tabIndex}
      className={cn(
        "border-b border-border align-middle",
        tall ? "h-10" : "h-7",
        selectable && "cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        // 選んだ行：地 selected-strong と最初のセルの左 3px の線。hover の地（muted）は選んだ行に当てない。
        // 線の色は ring（明るい地では primary と同じ値。暗い地でも地との対比 3:1 以上を保つ。docs/spec.md の 2.1）
        selected ? "bg-selected-strong [&>td:first-child]:shadow-[inset_3px_0_0_var(--color-ring)]" : "hover:bg-muted",
        className,
      )}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || !onSelect || isRowControl(e.target, e.currentTarget)) return;
        onSelect();
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || !onSelect || e.target !== e.currentTarget) return;
        const action = rowKeyAction(e.key, onOpen !== undefined);
        if (!action) return;
        e.preventDefault();
        if (action === "open") onOpen?.();
        else onSelect();
      }}
      {...props}
    />
  );
}

/** 見出しのセル（28px・12px・label。並べ替えない列）。pinned は操作の列（右端に固定。PINNED_HEAD） */
function TableHead({
  className,
  num = false,
  pinned = false,
  ...props
}: React.ComponentProps<"th"> & { num?: boolean; pinned?: boolean }) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-7 overflow-hidden px-2 py-0 text-left align-middle text-xs font-normal text-ellipsis whitespace-nowrap text-label",
        num && "text-right",
        pinned && PINNED_HEAD,
        className,
      )}
      {...props}
    />
  );
}

/**
 * 並べ替えのできる見出しのセル。見出しは並べ替えのボタンで、いまの並びの列は太字と矢印（昇順は上、降順は下）、th に aria-sort
 */
function SortableHead({
  sort,
  onSort,
  children,
  className,
  buttonTestId,
  ...props
}: Omit<React.ComponentProps<"th">, "onClick"> & {
  /** この列で並べているときの向き。並べていない列は undefined */
  sort: "asc" | "desc" | undefined;
  onSort: () => void;
  buttonTestId?: string;
}) {
  const Icon = sort === undefined ? ChevronsUpDown : sort === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={className}
      aria-sort={sort === undefined ? undefined : sort === "asc" ? "ascending" : "descending"}
      {...props}
    >
      <button
        type="button"
        data-testid={buttonTestId}
        onClick={onSort}
        className={cn(
          "inline-flex max-w-full items-center gap-0.5 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          sort !== undefined && "font-bold text-value",
        )}
      >
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{children}</span>
        <Icon aria-hidden className={cn("size-3.5 shrink-0", sort === undefined && "opacity-50")} />
      </button>
    </TableHead>
  );
}

/** 1 つのセル。num は数（右寄せ・桁をそろえる）。pinned は操作の列（右端に固定。PINNED_CELL） */
function TableCell({
  className,
  num = false,
  pinned = false,
  ...props
}: React.ComponentProps<"td"> & { num?: boolean; pinned?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      className={cn("px-2 py-0 align-middle", num && "num text-right tabular-nums", pinned && PINNED_CELL, className)}
      {...props}
    />
  );
}

/** 名前の列の値（`.main-c`。太字）。名前の列だけに使う */
function CellMain({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("main-c font-bold text-value", className)} {...props} />;
}

/** セルの補足（`.sub`。12px・label・2 行目） */
function CellSub({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("sub block text-xs text-label", className)} {...props} />;
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("mt-2 text-label", className)} {...props} />;
}

export { CellMain, CellSub, SortableHead, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow };
