import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // 押せる物の手応え（docs/spec.md の 2.3）：カーソルは globals.css の1か所、hover・押している間・フォーカスはここ。
  // 押せないときは薄くし、hover と押している間の変化を出さない（カーソルは禁止の形）
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground not-disabled:hover:bg-primary-hover not-disabled:active:bg-primary-active",
        outline:
          "border border-border bg-transparent not-disabled:hover:border-label not-disabled:hover:bg-hover not-disabled:active:bg-pressed",
        ghost: "not-disabled:hover:bg-hover not-disabled:active:bg-pressed",
        // 取り消せない操作の実行のボタン（削除する）。hover と押している間は地を暗くする
        danger: "bg-danger text-background not-disabled:hover:brightness-90 not-disabled:active:brightness-75",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2 text-xs",
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

export { Button, buttonVariants };
