import { modalityGroupOf, type ModalityGroup } from "@/lib/modalities";
import { cn } from "@/lib/utils";

// モダリティの印（docs/design-system/parts.md の「一覧の表」の `.mod`）。左 4px の色の線・地 surface・12px 太字の 1 つの形。
// 丸の点は使わない。一覧の表・患者バナー・検索の帯の見出しで同じ形を使う。

const LINE: Record<ModalityGroup, string> = {
  CT: "border-l-mod-ct",
  MR: "border-l-mod-mr",
  "CR/DX": "border-l-mod-crdx",
  US: "border-l-mod-us",
  ES: "border-l-mod-es",
  MG: "border-l-mod-mg",
  DOC: "border-l-mod-doc",
  SR: "border-l-mod-sr",
};

/** モダリティの群の色の線のクラス（群に入らないモダリティは label の灰） */
export function modalityLine(modality: string): string {
  const group = modalityGroupOf(modality);
  return group ? LINE[group] : "border-l-label";
}

export function ModalityMark({ modality, className }: { modality: string; className?: string }) {
  return (
    <span
      className={cn(
        "mod inline-flex h-5 items-center border-l-4 bg-surface pr-1 pl-1 text-xs leading-none font-bold whitespace-nowrap text-value",
        modalityLine(modality),
        className,
      )}
      data-modality={modality}
    >
      {modality}
    </span>
  );
}

/**
 * 押せるモダリティの印（一覧の行の中。docs/design-system/components.md の「一覧の表」の「セルから同じ値で絞る」）。
 * 印の形と色はそのままで、hover と focus で枠を出す。button なので、押しても行は選ばれない（ui/table の isRowControl）
 */
export function ModalityMarkButton({ modality, title, onClick }: { modality: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded-sm hover:ring-1 hover:ring-border-input focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      data-testid="narrow-modality"
    >
      <ModalityMark modality={modality} />
    </button>
  );
}
