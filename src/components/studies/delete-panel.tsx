"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionButton, PendingText } from "@/components/ui/pending";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { getJson } from "@/lib/client/api";
import { errorText, postJson, type PostResult } from "@/lib/client/post-json";
import type { StudyView } from "@/lib/fields";
import { formatSlashDate } from "@/lib/format/japanese-date";

// 検査の削除（docs/spec.md の 3.5。段 5）。管理者だけ。確かめの画面：消す検査を並べ、「戻せない」ことを示し、
// 理由を書いてから「削除する」を押す。大事な操作なので、BFF が再認証を求めたら、パスワードを入れてから続ける（TOTP は求めない）。
// 答えが分からなければ「結果不明」と要求の ID を出し、もう一度消さずに確かめる道（Orthanc にまだあるかを読む）だけを出す。
// 検査がまだあっても「消えていない」とは確定しない。管理者（照らし合わせの役割）は、Orthanc の側で先の削除が終わっていることを
// 確かめてから、確かめた内容を書いて手で解ける。

interface Preview {
  /** 確かめの画面で見せた検査（Orthanc の中の ID・UID・患者 ID・版）を結んだ token。消すときに添える */
  confirmToken: string;
  patientId: string;
  patientName: string;
  patientKana: string;
  studyDate: string;
  seriesCount: number;
  instanceCount: number;
}

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "reauth"; requestId: string; error?: string }
  | { kind: "deleted" }
  | { kind: "unknown"; requestId: string; note?: string }
  | { kind: "error"; text: string };

export function DeletePanel({
  study,
  screen,
  panelId,
  onClose,
  onDeleted,
}: {
  study: StudyView;
  screen: ScreenInfo;
  panelId: string;
  onClose: () => void;
  /** 消せたあと（一覧を読み直す） */
  onDeleted: () => void;
}) {
  const [reason, setReason] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /** 再認証の要求を送っている間 */
  const [authing, setAuthing] = useState(false);
  const uid = study.studyInstanceUid ?? "";
  // 確かめの画面に出すのは、BFF が Orthanc から読み直した、消す検査の要点（一覧の行の値ではない）。消すときに確かめの token を添える
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const fetchPreview = useCallback(() => {
    getJson<Preview>(`/api/studies/${encodeURIComponent(uid)}/delete`).then(setPreview, (e: Error) => setPreviewError(e.message));
  }, [uid]);
  useEffect(() => fetchPreview(), [fetchPreview]);
  /** 確かめの画面を読み直す（検査が変わった・消えていなかったと分かったとき。古い token のまま押し直させない） */
  function loadPreview() {
    setPreview(null);
    setPreviewError(null);
    fetchPreview();
  }

  function settle(result: PostResult, requestId: string) {
    if (result.status === 403 && result.data.problems?.includes("reauth_required")) {
      setPhase({ kind: "reauth", requestId });
      return;
    }
    if (result.data.outcome === "deleted") {
      setPhase({ kind: "deleted" });
      onDeleted();
    } else if (result.data.outcome === "failed") {
      // Orthanc が断った（受けなかったと分かる答え）。消えていない
      setPhase({ kind: "error", text: errorText(result) });
    } else if (result.data.outcome === "unknown" || result.status === 0 || result.status >= 500) {
      setPhase({ kind: "unknown", requestId });
    } else if (result.status === 409 && Array.isArray(result.data.pendingRequestIds) && typeof result.data.pendingRequestIds[0] === "string") {
      // この検査に、結果の分からない先の削除がある：その要求を確かめる道を出す（新しく消し直させない）
      setPhase({ kind: "unknown", requestId: result.data.pendingRequestIds[0], note: "この検査には結果未確認の削除があります" });
    } else {
      // 409（確かめの後に検査が変わった・同じ UID の検査が2つある・結果の分からない削除がある）は、確かめの画面を読み直す
      if (result.status === 409) loadPreview();
      setPhase({ kind: "error", text: errorText(result) });
    }
  }

  const postDelete = (requestId: string) =>
    postJson(`/api/studies/${encodeURIComponent(uid)}/delete`, { requestId, reason, confirmToken: preview?.confirmToken ?? "" }, screen.csrfToken);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const requestId = crypto.randomUUID();
    setPhase({ kind: "busy" });
    settle(await postDelete(requestId), requestId);
  }

  async function reauth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase.kind !== "reauth") return;
    const form = new FormData(event.currentTarget);
    setAuthing(true);
    const res = await postJson(
      "/api/auth/reauth",
      { password: form.get("password") },
      screen.csrfToken,
    );
    setAuthing(false);
    if (res.data.next) {
      window.location.assign(res.data.next);
      return;
    }
    if (!res.ok) {
      setPhase({ ...phase, error: errorText(res) });
      return;
    }
    // 同じ要求の ID で送り直す（再認証で断られた要求は「求めた」と数えていないので、Orthanc を呼ぶのはこの1回）
    const { requestId } = phase;
    setPhase({ kind: "busy" });
    settle(await postDelete(requestId), requestId);
  }

  async function check(requestId: string) {
    try {
      const r = await getJson<{ outcome: string; studyPresent?: boolean }>(
        `/api/studies/${encodeURIComponent(uid)}/delete?${new URLSearchParams({ requestId })}`,
      );
      if (r.outcome === "deleted") {
        setPhase({ kind: "deleted" });
        onDeleted();
      } else if (r.outcome === "not_deleted" || r.outcome === "failed") {
        setPhase({ kind: "error", text: "削除されていません（検査はサーバーに残っています）" });
        loadPreview();
      } else {
        setPhase({
          kind: "unknown",
          requestId,
          note: r.studyPresent
            ? "検査はまだサーバーに残っています。前回の削除が完了したかは不明です"
            : undefined,
        });
      }
    } catch (e) {
      // 確かめられなかったときも、結果不明のまま残す（消し直す道を出さない）
      setPhase({ kind: "unknown", requestId, note: `確認できませんでした（${(e as Error).message}）` });
    }
  }

  async function resolve(event: React.FormEvent<HTMLFormElement>, requestId: string) {
    event.preventDefault();
    const note = String(new FormData(event.currentTarget).get("note") ?? "");
    const res = await postJson(`/api/studies/${encodeURIComponent(uid)}/delete/resolve`, { requestId, note }, screen.csrfToken);
    if (res.data.outcome === "deleted") {
      setPhase({ kind: "deleted" });
      onDeleted();
    } else if (res.data.outcome === "not_deleted") {
      setPhase({ kind: "error", text: "解除しました。検査は削除されていません。削除する場合は、もう一度確認してから実行してください" });
      loadPreview();
    } else {
      setPhase({ kind: "unknown", requestId, note: errorText(res) });
    }
  }

  const busy = phase.kind === "busy";
  return (
    <div id={panelId} role="group" aria-label="検査の削除" className="mt-2 space-y-2 rounded-md border border-danger bg-surface p-3" data-testid="delete-panel">
      {previewError && (
        <p role="alert" className="text-danger" data-testid="delete-preview-error">
          {previewError}
        </p>
      )}
      {!preview && !previewError && (
        <p className="min-h-5">
          <PendingText pending>削除する検査を確認しています…</PendingText>
        </p>
      )}
      {preview && (
        // 確かめの画面：消す検査を表の形で並べ、取り消せないことを示す（docs/spec.md の 3.5）
        <div className="space-y-1 text-sm" data-testid="delete-confirm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-xs text-label">削除する検査</dt>
            <dd>
              <span className="font-bold text-value">{preview.patientId}</span>
              {preview.patientName ? ` ${preview.patientName}` : ""}／{formatSlashDate(preview.studyDate)} {study.modalities?.join("・")}／
              {preview.seriesCount} シリーズ・{preview.instanceCount} 画像
            </dd>
          </dl>
          <p className="font-bold text-danger">この操作は取り消せません。</p>
          <p className="text-xs text-label">元に戻すには、再度インポートするか送信元から再送します</p>
        </div>
      )}
      {preview && phase.kind !== "deleted" && phase.kind !== "reauth" && phase.kind !== "unknown" && (
        <form onSubmit={(e) => void submit(e)} className="space-y-2">
          <label className="block space-y-1">
            <span className="text-xs text-label">削除理由（必須・操作ログに記録）</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                // Escape は削除の画面だけを閉じる（詳細のパネルごと閉じて、書いた理由を失わないように。UX のレビューの M11）
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
              maxLength={500}
              required
              rows={2}
              className="w-full rounded-md border border-border-input bg-background px-2 py-1 text-sm text-value"
              data-testid="delete-reason"
            />
          </label>
          <div className="flex items-center gap-2">
            <ActionButton type="submit" size="sm" variant="danger" pending={busy} disabled={reason.trim() === ""} data-testid="delete-submit">
              削除する
            </ActionButton>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>
              キャンセル
            </Button>
          </div>
        </form>
      )}
      {phase.kind === "reauth" && (
        <form onSubmit={(e) => void reauth(e)} aria-label="再認証" className="max-w-sm space-y-2" data-testid="delete-reauth">
          {/* 再認証はパスワードだけ。一度通れば REAUTH_MINUTES の間は聞き直さない（docs/spec.md の 3.6） */}
          <p className="text-label">削除にはパスワードの再入力が必要です</p>
          <Input name="password" type="password" autoComplete="current-password" aria-label="パスワード" required />
          {phase.error && (
            <p role="alert" className="text-sm text-danger">
              {phase.error}
            </p>
          )}
          <div className="flex gap-2">
            <ActionButton type="submit" size="sm" pending={authing}>
              認証して削除
            </ActionButton>
            <Button type="button" size="sm" variant="outline" disabled={authing} onClick={() => setPhase({ kind: "idle" })}>
              キャンセル
            </Button>
          </div>
        </form>
      )}
      {busy && (
        <p>
          <PendingText pending>削除中…</PendingText>
        </p>
      )}
      {phase.kind === "deleted" && (
        <p role="status" className="font-bold text-value" data-testid="delete-status">
          削除しました
        </p>
      )}
      {phase.kind === "unknown" && (
        <div role="alert" className="space-y-1" data-testid="delete-status">
          <p className="text-danger">削除結果を確認できません。再実行せずに状態を確認してください</p>
          {phase.note && <p className="text-sm text-label">{phase.note}</p>}
          <p className="font-mono text-xs text-label">要求ID {phase.requestId}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void check(phase.requestId)}>
            状態を確認
          </Button>
          {screen.can.reconcile && (
            <form onSubmit={(e) => void resolve(e, phase.requestId)} aria-label="結果不明の削除の解除" className="space-y-1 pt-2" data-testid="delete-resolve">
              <p className="text-xs text-label">管理者：Orthanc のログで前回の削除の完了を確認してから解除してください</p>
              <textarea
                name="note"
                required
                maxLength={500}
                rows={2}
                aria-label="確認内容"
                className="w-full rounded-md border border-border-input bg-background px-2 py-1 text-sm text-value"
              />
              <Button type="submit" size="sm" variant="outline">
                確認済みとして解除
              </Button>
            </form>
          )}
        </div>
      )}
      {phase.kind === "error" && (
        <p role="alert" className="text-danger" data-testid="delete-status">
          {phase.text}
        </p>
      )}
    </div>
  );
}
