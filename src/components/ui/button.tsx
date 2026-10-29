import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 押している間の手応え（docs/spec.md の 2.3。parts.md の「ボタン」）：1px 沈む。ボタンの形の部品はどれもこれを使う
 * （Button のほか、Button を使わない押せる物も）。動きを減らす設定のときは、地の色の変化だけにする
 */
const pressFeedback =
  "transition-[color,background-color,border-color,box-shadow,translate,filter] duration-100 motion-reduce:transition-none motion-safe:not-disabled:active:translate-y-px";

/** 1つの並び（絞り込みの見出しなど）の中のボタンの手応え：並びを崩さないよう沈めずに、内側に影を付ける */
const pressInset =
  "transition-[color,background-color,box-shadow] duration-100 motion-reduce:transition-none active:shadow-[inset_0_2px_4px_rgb(0_0_0/0.2)]";

const buttonVariants = cva(
  // 押せる物の手応え（docs/spec.md の 2.3。docs/design-system/parts.md の「ボタン」）：カーソルは globals.css の1か所、hover・押している間・フォーカスはここ。
  // 角 4px・影なし。主だけ太字。押せないときは地 surface・字 label・枠 border で、hover と押している間の変化を出さない（カーソルは禁止の形）
  `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded border text-sm ${pressFeedback} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:border-border disabled:bg-surface disabled:font-normal disabled:text-label [&_svg]:size-4 [&_svg]:shrink-0`,
  {
    variants: {
      variant: {
        // 主（.btn-primary）
        default:
          "border-primary bg-primary font-bold text-primary-foreground not-disabled:hover:border-primary-hover not-disabled:hover:bg-primary-hover not-disabled:active:border-primary-active not-disabled:active:bg-primary-active",
        // 副（.btn）。白い地・枠 border-input
        outline: "border-border-input bg-background text-foreground not-disabled:hover:bg-hover not-disabled:active:bg-pressed",
        // 枠なし（.btn-ghost）
        ghost: "border-transparent bg-transparent text-foreground not-disabled:hover:bg-hover not-disabled:active:bg-pressed",
        // 取り消せない操作の実行のボタン（.btn-danger.fill。確認の窓の実行だけ）。hover と押している間は地を暗くする
        danger: "border-danger bg-danger font-bold text-danger-foreground not-disabled:hover:brightness-90 not-disabled:active:brightness-75",
      },
      size: {
        default: "h-8 min-w-16 px-3",
        sm: "h-7 min-w-12 px-2",
        // 一覧の 1 行（28px）に収める大きさ。押せる大きさの下限（24px。WCAG 2.2 の 2.5.8）ちょうど
        xs: "h-6 px-2 text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants, pressFeedback, pressInset };
