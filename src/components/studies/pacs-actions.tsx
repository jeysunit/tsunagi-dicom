"use client";

import { Download, Send, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { DeletePanel } from "@/components/studies/delete-panel";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { SendPanel } from "@/components/studies/send-panel";
import type { StudyView } from "@/lib/fields";

// 詳細のパネルの PACS の操作（docs/spec.md の 3.4・3.5）：送る（段 4）・書き出し（段 5）・削除（段 5。管理者だけ）。
// 役割に許された操作だけのボタンを 1 行に並べ、押した操作の画面をその下に出す（1 つずつ）。
// 行が替わったら、呼ぶ側が key に検査の UID を付けて作り直す（別の検査を送らない・消さないように）。
export function PacsActions({ study, screen, onChanged }: { study: StudyView; screen: ScreenInfo; onChanged: () => void }) {
  const [open, setOpen] = useState<"send" | "delete" | null>(null);
  const sendId = useId();
  const deleteId = useId();
  const uid = study.studyInstanceUid ?? "";
  if (!uid || !(screen.can.send || screen.can.export || screen.can.delete)) return null;
  const toggle = (which: "send" | "delete") => setOpen((v) => (v === which ? null : which));

  return (
    <div className="w-full" data-testid="pacs-actions">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="PACS の操作">
        {screen.can.send && (
          <Button type="button" size="sm" variant="outline" aria-expanded={open === "send"} aria-controls={sendId} data-testid="send-open" onClick={() => toggle("send")}>
            <Send aria-hidden />
            送る
          </Button>
        )}
        {screen.can.export && (
          // 書き出しは、BFF が記録してから ZIP を流す（同じ origin の画面からの要求だけを受ける）
          <a
            href={`/api/studies/${encodeURIComponent(uid)}/export`}
            download
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            data-testid="export-zip"
          >
            <Download aria-hidden className="size-4" />
            書き出し（ZIP）
          </a>
        )}
        {screen.can.delete && (
          <Button type="button" size="sm" variant="outline" aria-expanded={open === "delete"} aria-controls={deleteId} className="text-danger" data-testid="delete-open" onClick={() => toggle("delete")}>
            <Trash2 aria-hidden />
            削除
          </Button>
        )}
      </div>
      {screen.can.send && <SendPanel study={study} screen={screen} open={open === "send"} panelId={sendId} onClose={() => setOpen(null)} />}
      {screen.can.delete && open === "delete" && (
        <DeletePanel study={study} screen={screen} panelId={deleteId} onClose={() => setOpen(null)} onDeleted={onChanged} />
      )}
    </div>
  );
}
