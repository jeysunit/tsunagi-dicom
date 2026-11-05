"use client";

import { useCallback, useRef } from "react";
import { FilePicker } from "@/components/ui/file-picker";
import { importFile, type ImportBatch } from "@/lib/client/import-file";

// インポートの画面の中身（docs/spec.md の 3.5「取り込み」。段 6）。ファイルを選ぶ部品に、1 件ずつ BFF へ送る働きを渡す。
// 「インポート」を押すたびに、新しい組の ID を作る（BFF は、同じ組の中でだけ、先に入れた検査へ続きの画像を入れさせる）。

export function ImportScreen({ limitBytes, csrfToken }: { limitBytes: number; csrfToken?: string }) {
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
  return <FilePicker limitBytes={limitBytes} importFile={send} testId="import" />;
}
