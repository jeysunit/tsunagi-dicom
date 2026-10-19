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
  | { kind: "unknown"; requestId: string }
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
    if (outcome === "accepted" && typeof result.data.job === "string") {
      setPhase({ kind: "job", requestId, token: result.data.job, job: null });
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
      else if (r.outcome === "failed") setPhase({ kind: "error", text: "送れなかった（Orthanc が断った）" });
      else setPhase({ kind: "unknown", requestId });
    } catch (e) {
      setPhase({ kind: "error", text: (e as Error).message });
    }
  }

  const chosen = modalities?.find((m) => m.id === target);
  const busy = phase.kind === "sending" || (phase.kind === "job" && !(phase.job?.state === "Success" || phase.job?.state === "Failure"));

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
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
                  やめる
                </Button>
              </div>
            </>
          )}
          <SendStatus
            phase={phase}
            onCheck={(id) => void check(id)}
            onReread={() => setPhase((p) => (p.kind === "job" ? { ...p, readError: undefined } : p))}
          />
        </div>
      )}
    </>
  );
}

function SendStatus({ phase, onCheck, onReread }: { phase: Phase; onCheck: (requestId: string) => void; onReread: () => void }) {
  if (phase.kind === "idle") return null;
  if (phase.kind === "sending") return <p role="status" data-testid="send-status">送る準備をしている</p>;
  if (phase.kind === "error") {
    return (
      <p role="alert" className="text-danger" data-testid="send-status">
        {phase.text}
      </p>
    );
  }
  if (phase.kind === "unknown") {
    return (
      <div role="alert" className="space-y-1" data-testid="send-status">
        <p className="text-danger">結果が分からない。送り直さずに、状態を確かめる。</p>
        <p className="font-mono text-xs text-label">要求の ID {phase.requestId}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => onCheck(phase.requestId)}>
          確かめる
        </Button>
      </div>
    );
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
