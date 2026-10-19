"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { getJson } from "@/lib/client/api";
import { errorText, postJson, type PostResult } from "@/lib/client/post-json";
import type { StudyView } from "@/lib/fields";
import { formatSlashDate } from "@/lib/format/japanese-date";

// 検査の削除（docs/spec.md の 3.5。段 5）。管理者だけ。確かめの画面：消す検査を並べ、「戻せない」ことを示し、
// 理由を書いてから「削除」を押す。大事な操作なので、BFF が再認証を求めたら、パスワード（と確認の番号）を入れてから続ける。
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
      setPhase({ kind: "unknown", requestId: result.data.pendingRequestIds[0], note: "この検査に、結果の分からない先の削除がある。" });
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
    const res = await postJson(
      "/api/auth/reauth",
      { password: form.get("password"), ...(screen.reauth?.needsTotp ? { code: form.get("code") } : {}) },
      screen.csrfToken,
    );
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
        setPhase({ kind: "error", text: "消えていない（Orthanc に検査が残っている）" });
        loadPreview();
      } else {
        setPhase({
          kind: "unknown",
          requestId,
          note: r.studyPresent
            ? "検査は Orthanc にまだある。先の削除が止まったとも、遅れて消えるとも言えないので、結果不明のまま残す。"
            : undefined,
        });
      }
    } catch (e) {
      // 確かめられなかったときも、結果不明のまま残す（消し直す道を出さない）
      setPhase({ kind: "unknown", requestId, note: `確かめられなかった（${(e as Error).message}）` });
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
      setPhase({ kind: "error", text: "解いた：消えていない（Orthanc に検査が残っている）。消すなら、もう一度確かめてから" });
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
      {!preview && !previewError && <p className="text-label">消す検査を Orthanc から読んでいる</p>}
      {preview && (
        <p className="text-sm" data-testid="delete-confirm">
          <span className="font-bold text-value">{preview.patientId}</span>
          {preview.patientName ? ` ${preview.patientName}` : ""}・{formatSlashDate(preview.studyDate)}・{study.modalities?.join("・")}・
          {preview.seriesCount} シリーズ・{preview.instanceCount} 画像 を Orthanc から消す。
          <span className="font-bold text-danger">戻せない。</span>戻すには、取り込み直すか、送り元から送り直す。
        </p>
      )}
      {preview && phase.kind !== "deleted" && phase.kind !== "reauth" && phase.kind !== "unknown" && (
        <form onSubmit={(e) => void submit(e)} className="space-y-2">
          <label className="block space-y-1">
            <span className="text-xs text-label">理由（必須。監査の記録に残る）</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              required
              rows={2}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-value"
              data-testid="delete-reason"
            />
          </label>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || reason.trim() === ""} className="bg-danger text-background hover:bg-danger" data-testid="delete-submit">
              削除
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
              やめる
            </Button>
          </div>
        </form>
      )}
      {phase.kind === "reauth" && (
        <form onSubmit={(e) => void reauth(e)} aria-label="本人の確かめ" className="max-w-sm space-y-2" data-testid="delete-reauth">
          <p className="text-label">削除は大事な操作なので、パスワード{screen.reauth?.needsTotp ? "と確認の番号" : ""}をもう一度入れる。</p>
          <Input name="password" type="password" autoComplete="current-password" aria-label="パスワード" required />
          {screen.reauth?.needsTotp && (
            <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} aria-label="確認の番号" required />
          )}
          {phase.error && (
            <p role="alert" className="text-sm text-danger">
              {phase.error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              確かめて消す
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setPhase({ kind: "idle" })}>
              やめる
            </Button>
          </div>
        </form>
      )}
      {busy && <p role="status">消している</p>}
      {phase.kind === "deleted" && (
        <p role="status" className="font-bold text-value" data-testid="delete-status">
          消した
        </p>
      )}
      {phase.kind === "unknown" && (
        <div role="alert" className="space-y-1" data-testid="delete-status">
          <p className="text-danger">結果が分からない。もう一度消さずに、状態を確かめる。</p>
          {phase.note && <p className="text-sm text-label">{phase.note}</p>}
          <p className="font-mono text-xs text-label">要求の ID {phase.requestId}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void check(phase.requestId)}>
            確かめる
          </Button>
          {screen.can.reconcile && (
            <form onSubmit={(e) => void resolve(e, phase.requestId)} aria-label="結果不明の削除を解く" className="space-y-1 pt-2" data-testid="delete-resolve">
              <p className="text-xs text-label">
                管理者：Orthanc の側（ログ・再起動の有無など）で、先の削除の処理が終わっていることを確かめてから解く。解くと、同じ検査をまた消せる。
              </p>
              <textarea
                name="note"
                required
                maxLength={500}
                rows={2}
                aria-label="確かめた内容"
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-value"
              />
              <Button type="submit" size="sm" variant="outline">
                確かめて解く
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
