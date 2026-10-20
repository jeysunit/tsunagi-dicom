"use client";

import { CheckCircle2, Download, Send, Trash2, XCircle } from "lucide-react";
import { useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/pending";
import { DeletePanel } from "@/components/studies/delete-panel";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { SendPanel, type SendActivity } from "@/components/studies/send-panel";
import type { StudyView } from "@/lib/fields";
import { cn } from "@/lib/utils";

// 詳細のパネルの PACS の操作（docs/spec.md の 3.4・3.5）：送る（段 4）・書き出し（段 5）・削除（段 5。管理者だけ）。
// 役割に許された操作だけのボタンを 1 行に並べ、押した操作の画面をその下に出す（1 つずつ）。
// 行が替わったら、呼ぶ側が key に検査の UID を付けて作り直す（別の検査を送らない・消さないように）。
// 画面の言葉は docs/spec.md の 2.2（送信・エクスポート（ZIP）・削除…）。
export function PacsActions({ study, screen, onDeleted }: { study: StudyView; screen: ScreenInfo; onDeleted: (study: StudyView) => void }) {
  const [open, setOpen] = useState<"send" | "delete" | null>(null);
  // 送信の画面を閉じた後も、送信の状態を「送信」のボタンの横に出す（Orthanc の送信は閉じても続く。docs/spec.md の 3.4）
  const [activity, setActivity] = useState<SendActivity | null>(null);
  const sendId = useId();
  const deleteId = useId();
  const uid = study.studyInstanceUid ?? "";
  if (!uid || !(screen.can.send || screen.can.export || screen.can.delete)) return null;
  const toggle = (which: "send" | "delete") => setOpen((v) => (v === which ? null : which));

  return (
    <div className="w-full" data-testid="pacs-actions">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="検査の操作">
        {screen.can.send && (
          <Button type="button" size="sm" variant="outline" aria-expanded={open === "send"} aria-controls={sendId} data-testid="send-open" onClick={() => toggle("send")}>
            <Send aria-hidden />
            送信
          </Button>
        )}
        {screen.can.send && open !== "send" && activity && <SendBadge activity={activity} />}
        {screen.can.export && (
          // 書き出しは、BFF が記録してから ZIP を流す（同じ origin の画面からの要求だけを受ける）
          <a
            href={`/api/studies/${encodeURIComponent(uid)}/export`}
            download
            className={buttonVariants({ variant: "outline", size: "sm" })}
            data-testid="export-zip"
          >
            <Download aria-hidden className="size-4" />
            エクスポート（ZIP）
          </a>
        )}
        {screen.can.delete && (
          <Button type="button" size="sm" variant="outline" aria-expanded={open === "delete"} aria-controls={deleteId} className="text-danger" data-testid="delete-open" onClick={() => toggle("delete")}>
            <Trash2 aria-hidden />
            削除…
          </Button>
        )}
      </div>
      {screen.can.send && (
        <SendPanel study={study} screen={screen} open={open === "send"} panelId={sendId} onClose={() => setOpen(null)} onStatus={setActivity} />
      )}
      {screen.can.delete && open === "delete" && (
        <DeletePanel study={study} screen={screen} panelId={deleteId} onClose={() => setOpen(null)} onDeleted={() => onDeleted(study)} />
      )}
    </div>
  );
}

/** 閉じた送信の画面の状態（「送信」のボタンの横。押すと画面が開いて、詳しい状態が出る） */
function SendBadge({ activity }: { activity: SendActivity }) {
  const view = {
    sending: { icon: <Spinner className="size-3.5" />, text: "送信中", tone: "text-label" },
    success: { icon: <CheckCircle2 aria-hidden className="size-3.5" />, text: "送信完了", tone: "text-success" },
    failure: { icon: <XCircle aria-hidden className="size-3.5" />, text: "送信失敗", tone: "text-danger" },
    unknown: { icon: <XCircle aria-hidden className="size-3.5" />, text: "結果不明", tone: "text-danger" },
    stalled: { icon: <XCircle aria-hidden className="size-3.5" />, text: "状態を取得できません", tone: "text-danger" },
  }[activity];
  return (
    <span role="status" className={cn("inline-flex items-center gap-1 text-xs", view.tone)} data-testid="send-badge" data-activity={activity}>
      {view.icon}
      {view.text}
    </span>
  );
}
