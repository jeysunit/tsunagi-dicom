"use client";

import { useCallback, useRef } from "react";
import { FilePicker } from "@/components/ui/file-picker";
import { importFile, resolveImport, type ImportBatch } from "@/lib/client/import-file";
import type { ResolveTarget } from "@/lib/import/picker-model";

// インポートの画面の中身（docs/spec.md の 3.5「取り込み」。フェーズ 6）。ファイルを選ぶ部品に、1 件ずつ BFF へ送る働きを渡す。
// 「インポート」を押すたびに、新しい組の ID を作る（BFF は、同じ組の中でだけ、先に入れた検査へ続きの画像を入れさせる）。
// canResolve（結果不明を照らせる役割＝管理者）のときだけ、結果不明の行を確認して記録する働きも渡す。

export function ImportScreen({
  limitBytes,
  csrfToken,
  unknownHelp,
  canResolve = false,
}: {
  limitBytes: number;
  csrfToken?: string;
  unknownHelp?: string;
  canResolve?: boolean;
}) {
  const batch = useRef<string>("");
  const send = useCallback(
    (file: File, at: { index: number; total: number }) => {
      // 部品は、押すたびに 0 番目から送る
      if (at.index === 0 || !batch.current) batch.current = crypto.randomUUID();
      const b: ImportBatch = { id: batch.current, index: at.index + 1, total: at.total };
      return importFile(file, b, csrfToken);
    },
    [csrfToken],
  );
  const resolve = useCallback(
    (target: ResolveTarget, outcome: "success" | "failed", note: string) => resolveImport(target, outcome, note, csrfToken),
    [csrfToken],
  );
  return (
    <FilePicker
      limitBytes={limitBytes}
      importFile={send}
      unknownHelp={unknownHelp}
      resolveUnknown={canResolve ? resolve : undefined}
      testId="import"
    />
  );
}
