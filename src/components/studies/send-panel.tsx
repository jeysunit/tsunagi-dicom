"use client";

import { CheckCircle2, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ActionButton, PendingText } from "@/components/ui/pending";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { getJson } from "@/lib/client/api";
import { errorText, postJson } from "@/lib/client/post-json";
import type { ModalityView, StudyView } from "@/lib/fields";
import { formatDateTimeIn, formatSlashDate } from "@/lib/format/japanese-date";

// ほかの機器へ送る（docs/spec.md の 3.4。段 4）。詳細のパネルの「送信」から、登録された機器を選び、
// 確かめの画面（検査と送り先を2行の表に並べる）を通して送る。送ったあとは、Orthanc の仕事の状態を終わるまで読んで出す。
// 書き込みの要求は自分で送り直さない。答えが分からなければ「結果不明」と要求の ID を出し、送り直さずに確かめる道だけを出す。
// 送信を受け付けた後は、同じ確かめの画面から重ねて送らない：実行のボタンを外して「閉じる」だけを出す（2026-10-20。UX のレビューの H7）。
// 続けて送るときは、送信先を選び直すか、閉じて開き直す（新しい要求の ID になる）。
// 画面の言葉は docs/spec.md の 2.2 の用語集から選ぶ。

interface JobView {
  state: "Pending" | "Running" | "Success" | "Failure" | "Paused" | "Retry";
  progress: number;
  errorDescription: string;
  /** 終わった時刻（UTC。Z つき）。終わっていなければ null */
  completionTime?: string | null;
}

/** 送った相手（結果に出す） */
interface Target {
  id: string;
  aet: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "sending"; target: Target }
  | { kind: "job"; requestId: string; token: string; target: Target; job: JobView | null; readError?: string }
  /** 結果不明。照らし合わせが済むまで、この画面からは送り直させない（BFF の側でも断る） */
  | { kind: "unknown"; requestId: string; checkError?: string }
  /** 照らし合わせで結果が分かった（管理者が確かめた・確かめの道で分かった） */
  | { kind: "settled"; text: string }
  | { kind: "error"; text: string };

const POLL_MS = 1500;

/** Orthanc の仕事の状態の、画面の言葉（docs/spec.md の 2.2） */
export const SEND_STATE_TEXT: Record<JobView["state"], string> = {
  Pending: "待機中",
  Running: "送信中",
  Success: "送信完了",
  Failure: "送信失敗",
  Paused: "一時停止中",
  Retry: "再試行待ち",
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

  // 仕事の状態を、終わるまで読む。読めなかったときは token と要求の ID を残したまま止め、「再読み込み」を出す
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

  const chosen = modalities?.find((m) => m.id === target);

  async function send() {
    if (!target) return;
    const requestId = crypto.randomUUID();
    const to: Target = { id: target, aet: chosen?.aet ?? "" };
    setPhase({ kind: "sending", target: to });
    const result = await postJson(`/api/studies/${encodeURIComponent(uid)}/send`, { modality: target, requestId }, screen.csrfToken);
    const outcome = result.data.outcome;
    const pending = result.data.pendingRequestIds;
    if (outcome === "accepted" && typeof result.data.job === "string") {
      setPhase({ kind: "job", requestId, token: result.data.job, target: to, job: null });
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
      if (r.outcome === "accepted" && r.job) setPhase({ kind: "job", requestId, token: r.job, target: { id: target, aet: chosen?.aet ?? "" }, job: null });
      else if (r.outcome === "failed") setPhase({ kind: "settled", text: "送信されていませんでした。再送できます" });
      else if (r.outcome === "delivered") setPhase({ kind: "settled", text: "送信済み（管理者が確認）" });
      else setPhase({ kind: "unknown", requestId });
    } catch (e) {
      // 確かめの通信が失敗しても、結果不明のまま要求の ID と確かめの道を残す
      setPhase({ kind: "unknown", requestId, checkError: (e as Error).message });
    }
  }

  /** 管理者が送り先で確かめた結果を、記録に足す（照らし合わせ） */
  async function resolve(requestId: string, delivered: boolean, note: string) {
    const result = await postJson(`/api/studies/${encodeURIComponent(uid)}/send/resolve`, { requestId, delivered, note }, screen.csrfToken);
    if (result.ok) setPhase({ kind: "settled", text: delivered ? "送信済みとして記録しました" : "未送信として記録しました。再送できます" });
    else setPhase({ kind: "unknown", requestId, checkError: errorText(result) });
  }

  // 結果不明の間・送っている間は送れない（新しい要求の ID で重ねて送らない）
  const inFlight =
    phase.kind === "sending" ||
    phase.kind === "unknown" ||
    (phase.kind === "job" && !(phase.job?.state === "Success" || phase.job?.state === "Failure"));
  // 送信を受け付けた後（終わった後も）は、同じ画面から重ねて送らない。送信先を選び直すと、新しい送信の確かめの画面に戻る
  const sent = phase.kind !== "idle" && phase.kind !== "error";

  /** 閉じる：送り終えた・断られた画面は片付ける（開き直すと新しい送信の確かめの画面）。送っている間・結果不明の間は残す */
  function close() {
    if (!inFlight) setPhase({ kind: "idle" });
    onClose();
  }

  return (
    <>
      {open && (
        <div id={panelId} role="group" aria-label="検査の送信" className="mt-2 space-y-2 rounded-md border border-border bg-surface p-3" data-testid="send-panel">
          {loadError && (
            <p role="alert" className="text-danger">
              {loadError}
            </p>
          )}
          {modalities && modalities.length === 0 && <p className="text-label">送信先が登録されていません（Orthanc の設定で登録します）</p>}
          {modalities && modalities.length > 0 && (
            <>
              <label className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-label">送信先</span>
                <select
                  className="h-7 rounded-md border border-control bg-background px-2 text-value"
                  value={target}
                  disabled={inFlight}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    // 送信先を選び直したら、新しい送信の確かめの画面に戻る
                    if (!inFlight) setPhase({ kind: "idle" });
                  }}
                  data-testid="send-modality"
                >
                  {modalities.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}（AE: {m.aet}）
                    </option>
                  ))}
                </select>
              </label>
              {/* 確かめの画面：送る検査と送り先を2行の表に並べる */}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="send-confirm">
                <dt className="text-xs text-label">送信する検査</dt>
                <dd>
                  <span className="font-bold text-value">{study.patientId}</span>
                  {study.patientName ? ` ${study.patientName}` : ""}／{formatSlashDate(study.studyDate)} {study.modalities?.join("・")}／
                  {study.instanceCount ?? "—"} 画像
                </dd>
                <dt className="text-xs text-label">送信先</dt>
                <dd className="font-bold text-value">
                  {chosen?.id}（{chosen?.aet}）
                </dd>
              </dl>
              <div className="flex items-center gap-2">
                {!sent && (
                  <ActionButton type="button" size="sm" disabled={!target} data-testid="send-submit" icon={<Send aria-hidden />} onClick={() => void send()}>
                    送信する
                  </ActionButton>
                )}
                <Button type="button" size="sm" variant="outline" disabled={phase.kind === "sending"} onClick={close} data-testid="send-close">
                  {sent ? "閉じる" : "キャンセル"}
                </Button>
              </div>
            </>
          )}
          <SendStatus
            phase={phase}
            timeZone={screen.timeZone}
            instanceCount={study.instanceCount}
            onCheck={(id) => void check(id)}
            onReread={() => setPhase((p) => (p.kind === "job" ? { ...p, readError: undefined } : p))}
            onResolve={screen.can.reconcile ? (id, delivered, note) => void resolve(id, delivered, note) : undefined}
          />
        </div>
      )}
    </>
  );
}

/** 時刻だけ（`10:32:15`）。終わった時刻が無ければ、いまの時刻 */
function timeOf(iso: string | null | undefined, timeZone: string): string {
  const at = iso && formatDateTimeIn(iso, timeZone, { seconds: true }) ? iso : new Date().toISOString();
  return formatDateTimeIn(at, timeZone, { seconds: true }).split(" ")[1] ?? "";
}

function SendStatus({
  phase,
  timeZone,
  instanceCount,
  onCheck,
  onReread,
  onResolve,
}: {
  phase: Phase;
  timeZone: string;
  instanceCount: number | null | undefined;
  onCheck: (requestId: string) => void;
  onReread: () => void;
  /** 管理者だけ：送り先で確かめた結果を記録に足す */
  onResolve?: (requestId: string, delivered: boolean, note: string) => void;
}) {
  if (phase.kind === "idle") return null;
  if (phase.kind === "sending") {
    return (
      <p data-testid="send-status">
        <PendingText pending>送信を開始しています…</PendingText>
      </p>
    );
  }
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
        <p className="text-danger">状態を取得できませんでした（{phase.readError}）。再送せずに「再読み込み」を押してください</p>
        <p className="font-mono text-xs text-label">要求ID {phase.requestId}</p>
        <Button type="button" size="sm" variant="outline" onClick={onReread}>
          再読み込み
        </Button>
      </div>
    );
  }
  const to = `${phase.target.id}（${phase.target.aet}）`;
  if (job?.state === "Success") {
    return (
      <p role="status" className="flex items-center gap-1.5 font-bold text-success" data-testid="send-status" data-state="Success">
        <CheckCircle2 aria-hidden className="size-4" />
        <span data-testid="send-result">
          {SEND_STATE_TEXT.Success}：{to} へ {instanceCount ?? "—"} 画像（{timeOf(job.completionTime, timeZone)}）
        </span>
      </p>
    );
  }
  const text = job ? SEND_STATE_TEXT[job.state] : "送信を受け付けました";
  return (
    <p role="status" className={job?.state === "Failure" ? "text-danger" : undefined} data-testid="send-status" data-state={job?.state ?? "Accepted"}>
      {text}
      {job?.state === "Running" ? `（${job.progress}%）` : ""}
      {job?.state === "Failure" && job.errorDescription ? `：${job.errorDescription}` : ""}
      {job?.state === "Failure" ? `（${to}・${timeOf(job.completionTime, timeZone)}）` : ""}
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
      <p className="text-danger">送信結果を確認できません。再送せずに状態を確認してください。確認が終わるまで、同じ送信先へは送信できません</p>
      <p className="font-mono text-xs text-label">要求ID {requestId}</p>
      {checkError && <p className="text-xs text-danger">確認できませんでした：{checkError}</p>}
      <Button type="button" size="sm" variant="outline" onClick={() => onCheck(requestId)} data-testid="send-check">
        状態を確認
      </Button>
      {onResolve && (
        <div className="space-y-1 pt-1" data-testid="send-resolve">
          <label className="block">
            <span className="text-xs text-label">送信先での確認内容（管理者・操作ログに記録）</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              className="h-7 w-full rounded-md border border-control bg-background px-2 text-sm text-value"
              data-testid="send-resolve-note"
            />
          </label>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={note.trim() === ""} onClick={() => onResolve(requestId, true, note)}>
              送信済みとして記録
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={note.trim() === ""} onClick={() => onResolve(requestId, false, note)}>
              未送信として記録
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
