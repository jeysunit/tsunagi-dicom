"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { getJson } from "@/lib/client/api";
import { errorText, postJson } from "@/lib/client/post-json";
import type { ModalityView, StudyView } from "@/lib/fields";
import { formatSlashDate } from "@/lib/format/japanese-date";

// ほかの機器へ送る（docs/spec.md の 3.4。段 4）。詳細のパネルの「送る」から、登録された機器を選び、
// 確かめの画面（検査と送り先を並べる）を通して送る。送ったあとは、Orthanc の仕事の状態を終わるまで読んで出す。
// 書き込みの要求は自分で送り直さない。答えが分からなければ「結果不明」と要求の ID を出し、送り直さずに確かめる道だけを出す。

interface JobView {
  state: "Pending" | "Running" | "Success" | "Failure" | "Paused" | "Retry";
  progress: number;
  errorDescription: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "job"; requestId: string; token: string; job: JobView | null; readError?: string }
  /** 結果不明。照らし合わせが済むまで、この画面からは送り直させない（BFF の側でも断る） */
  | { kind: "unknown"; requestId: string; checkError?: string }
  /** 照らし合わせで結果が分かった（管理者が確かめた・確かめの道で分かった） */
  | { kind: "settled"; text: string }
  | { kind: "error"; text: string };

const POLL_MS = 1500;

const STATE_TEXT: Record<JobView["state"], string> = {
  Pending: "送る順を待っている",
  Running: "送っている",
  Success: "送った",
  Failure: "送れなかった",
  Paused: "止まっている",
  Retry: "やり直しを待っている",
};

/** 送る画面（開閉は呼ぶ側の PacsActions が持つ。ボタンもそちら） */
export function SendPanel({
  study,
  screen,
  open,
  panelId,
  onClose,
}: {
  study: StudyView;
  screen: ScreenInfo;
  open: boolean;
  panelId: string;
  onClose: () => void;
}) {
  const [modalities, setModalities] = useState<ModalityView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const uid = study.studyInstanceUid ?? "";
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open || modalities) return;
    getJson<{ modalities: ModalityView[] }>("/api/modalities").then(
      (r) => {
        setModalities(r.modalities);
        setTarget((t) => t || r.modalities[0]?.id || "");
      },
      (e: Error) => setLoadError(e.message),
    );
  }, [open, modalities]);

  // 仕事の状態を、終わるまで読む。読めなかったときは token と要求の ID を残したまま止め、「読み直す」を出す
  useEffect(() => {
    if (phase.kind !== "job" || phase.readError) return;
    if (phase.job && (phase.job.state === "Success" || phase.job.state === "Failure")) return;
    timer.current = window.setTimeout(() => {
      getJson<JobView>(`/api/jobs/${encodeURIComponent(phase.token)}`).then(
        (job) => setPhase((p) => (p.kind === "job" && p.token === phase.token ? { ...p, job, readError: undefined } : p)),
        (e: Error) => setPhase((p) => (p.kind === "job" && p.token === phase.token ? { ...p, readError: e.message } : p)),
      );
    }, phase.job ? POLL_MS : 0);
    return () => window.clearTimeout(timer.current);
  }, [phase]);

  // 行が替わったら、送る画面を閉じる（別の検査を送らないように）：呼ぶ側が key に検査の UID を付けて、作り直す

  if (!screen.can.send || !uid) return null;

  async function send() {
    if (!target) return;
    const requestId = crypto.randomUUID();
    setPhase({ kind: "sending" });
    const result = await postJson(`/api/studies/${encodeURIComponent(uid)}/send`, { modality: target, requestId }, screen.csrfToken);
    const outcome = result.data.outcome;
    const pending = result.data.pendingRequestIds;
    if (outcome === "accepted" && typeof result.data.job === "string") {
      setPhase({ kind: "job", requestId, token: result.data.job, job: null });
    } else if (result.status === 409 && Array.isArray(pending) && typeof pending[0] === "string") {
      // 同じ検査を同じ送り先へ送った、結果の分からない要求がある：そちらを確かめる
      setPhase({ kind: "unknown", requestId: pending[0] });
    } else if (outcome === "unknown" || result.status === 0 || result.status >= 500 || (outcome === undefined && result.ok)) {
      // 答えが届かない・中で失敗した（BFF や手前の入口の 5xx）・答えを読めない：Orthanc は送ったかもしれないので結果不明
      setPhase({ kind: "unknown", requestId });
    } else {
      setPhase({ kind: "error", text: errorText(result) });
    }
  }

  async function check(requestId: string) {
    try {
      const r = await getJson<{ outcome: string; job?: string }>(
        `/api/studies/${encodeURIComponent(uid)}/send?${new URLSearchParams({ requestId })}`,
      );
      if (r.outcome === "accepted" && r.job) setPhase({ kind: "job", requestId, token: r.job, job: null });
      else if (r.outcome === "failed") setPhase({ kind: "settled", text: "送れていなかった。送り直せる" });
      else if (r.outcome === "delivered") setPhase({ kind: "settled", text: "届いていた（管理者が確かめた）" });
      else setPhase({ kind: "unknown", requestId });
    } catch (e) {
      // 確かめの通信が失敗しても、結果不明のまま要求の ID と確かめの道を残す
      setPhase({ kind: "unknown", requestId, checkError: (e as Error).message });
    }
  }

  /** 管理者が送り先で確かめた結果を、記録に足す（照らし合わせ） */
  async function resolve(requestId: string, delivered: boolean, note: string) {
    const result = await postJson(`/api/studies/${encodeURIComponent(uid)}/send/resolve`, { requestId, delivered, note }, screen.csrfToken);
    if (result.ok) setPhase({ kind: "settled", text: delivered ? "届いていたと記録した" : "届いていなかったと記録した。送り直せる" });
    else setPhase({ kind: "unknown", requestId, checkError: errorText(result) });
  }

  const chosen = modalities?.find((m) => m.id === target);
  // 結果不明の間は送れない（新しい要求の ID で重ねて送らない）。照らし合わせで分かったら、また送れる
  const busy =
    phase.kind === "sending" ||
    phase.kind === "unknown" ||
    (phase.kind === "job" && !(phase.job?.state === "Success" || phase.job?.state === "Failure"));

  return (
    <>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="ほかの機器へ送る"
          className="mt-2 space-y-2 rounded-md border border-border bg-surface p-3"
          data-testid="send-panel"
        >
          {loadError && (
            <p role="alert" className="text-danger">
              {loadError}
            </p>
          )}
          {modalities && modalities.length === 0 && <p className="text-label">Orthanc に機器が登録されていない。</p>}
          {modalities && modalities.length > 0 && (
            <>
              <label className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-label">送り先の機器</span>
                <select
                  className="h-7 rounded-md border border-border bg-background px-2 text-value"
                  value={target}
                  disabled={busy}
                  onChange={(e) => setTarget(e.target.value)}
                  data-testid="send-modality"
                >
                  {modalities.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}（{m.aet}）
                    </option>
                  ))}
                </select>
              </label>
              {/* 確かめの画面：送る検査と送り先を並べる */}
              <p className="text-sm" data-testid="send-confirm">
                <span className="font-bold text-value">{study.patientId}</span>
                {study.patientName ? ` ${study.patientName}` : ""}・{formatSlashDate(study.studyDate)}・{study.modalities?.join("・")}・
                {study.instanceCount ?? "—"} 画像 を、<span className="font-bold text-value">{chosen?.id}（{chosen?.aet}）</span> へ送る
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" disabled={busy || !target} data-testid="send-submit" onClick={() => void send()}>
                  送る
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>
                  やめる
                </Button>
              </div>
            </>
          )}
          <SendStatus
            phase={phase}
            onCheck={(id) => void check(id)}
            onReread={() => setPhase((p) => (p.kind === "job" ? { ...p, readError: undefined } : p))}
            onResolve={screen.can.reconcile ? (id, delivered, note) => void resolve(id, delivered, note) : undefined}
          />
        </div>
      )}
    </>
  );
}

function SendStatus({
  phase,
  onCheck,
  onReread,
  onResolve,
}: {
  phase: Phase;
  onCheck: (requestId: string) => void;
  onReread: () => void;
  /** 管理者だけ：送り先で確かめた結果を記録に足す */
  onResolve?: (requestId: string, delivered: boolean, note: string) => void;
}) {
  if (phase.kind === "idle") return null;
  if (phase.kind === "sending") return <p role="status" data-testid="send-status">送る準備をしている</p>;
  if (phase.kind === "error") {
    return (
      <p role="alert" className="text-danger" data-testid="send-status">
        {phase.text}
      </p>
    );
  }
  if (phase.kind === "settled") {
    return (
      <p role="status" data-testid="send-status" data-state="Settled">
        {phase.text}
      </p>
    );
  }
  if (phase.kind === "unknown") {
    return <UnknownStatus requestId={phase.requestId} checkError={phase.checkError} onCheck={onCheck} onResolve={onResolve} />;
  }
  const job = phase.job;
  if (phase.readError) {
    return (
      <div role="alert" className="space-y-1" data-testid="send-status" data-state={job?.state ?? "Accepted"}>
        <p className="text-danger">状態を読めなかった（{phase.readError}）。送り直さずに、読み直す。</p>
        <p className="font-mono text-xs text-label">要求の ID {phase.requestId}</p>
        <Button type="button" size="sm" variant="outline" onClick={onReread}>
          読み直す
        </Button>
      </div>
    );
  }
  const text = job ? STATE_TEXT[job.state] : "送り始めた";
  return (
    <p role="status" className={job?.state === "Failure" ? "text-danger" : undefined} data-testid="send-status" data-state={job?.state ?? "Accepted"}>
      {text}
      {job?.state === "Running" ? `（${job.progress}%）` : ""}
      {job?.state === "Failure" && job.errorDescription ? `：${job.errorDescription}` : ""}
    </p>
  );
}

/** 結果不明：要求の ID と確かめの道を出し続ける。管理者には、送り先で確かめた結果を記録に足す道も出す */
function UnknownStatus({
  requestId,
  checkError,
  onCheck,
  onResolve,
}: {
  requestId: string;
  checkError?: string;
  onCheck: (requestId: string) => void;
  onResolve?: (requestId: string, delivered: boolean, note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div role="alert" className="space-y-1" data-testid="send-status" data-state="Unknown">
      <p className="text-danger">結果が分からない。送り直さずに、状態を確かめる（確かめるまで、同じ検査を同じ機器へは送れない）。</p>
      <p className="font-mono text-xs text-label">要求の ID {requestId}</p>
      {checkError && <p className="text-xs text-danger">確かめられなかった：{checkError}</p>}
      <Button type="button" size="sm" variant="outline" onClick={() => onCheck(requestId)} data-testid="send-check">
        確かめる
      </Button>
      {onResolve && (
        <div className="space-y-1 pt-1" data-testid="send-resolve">
          <label className="block">
            <span className="text-xs text-label">送り先で確かめた内容（管理者。記録に残る）</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              className="h-7 w-full rounded-md border border-border bg-background px-2 text-sm text-value"
              data-testid="send-resolve-note"
            />
          </label>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={note.trim() === ""} onClick={() => onResolve(requestId, true, note)}>
              届いていた
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={note.trim() === ""} onClick={() => onResolve(requestId, false, note)}>
              届いていなかった
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
