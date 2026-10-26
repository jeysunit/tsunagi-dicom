"use client";

import { CheckCircle2, RotateCcw, Send, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmActions, ConfirmPanel } from "@/components/ui/confirm-panel";
import { ProgressBar, Spinner } from "@/components/ui/pending";
import { Select } from "@/components/ui/select";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { getJson } from "@/lib/client/api";
import { errorText, postJson } from "@/lib/client/post-json";
import type { ModalityView, StudyView } from "@/lib/fields";
import { formatBirthLine, formatDateTimeIn, formatSlashDate } from "@/lib/format/japanese-date";
import { cn } from "@/lib/utils";

// ほかの機器へ送る（docs/spec.md の 3.4。段 4）。詳細のパネルの「送信」から、登録された機器を選び、
// 確かめの画面（検査と送り先を2行の表に並べる）を通して送る。送ったあとは、Orthanc の仕事の状態を終わるまで読んで出す。
// 書き込みの要求は自分で送り直さない。答えが分からなければ「結果不明」と要求の ID を出し、送り直さずに確かめる道だけを出す。
// 送信を受け付けた後は、同じ確かめの画面から重ねて送らない：実行のボタンを外して「閉じる」だけを出す（2026-10-20。UX のレビューの H7）。
// 手応え（2026-10-21。承認者の指摘）：押した直後から、待ちの印つきの状態の枠を出す（0.3 秒を待たない）。送っている間は進みの帯と
// 「閉じても送信は続きます」、終わったら印つきの完了・失敗の枠と「再送信…」（新しい要求の ID で、確かめの画面に戻る）を出す。
// 閉じた後も、送信の状態は「送信」のボタンの横に出す（呼ぶ側の PacsActions。onStatus）。
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
  /** 照らし合わせで結果が分かった（管理者が確かめた・確かめの道で分かった）。resend は再送してよいとき */
  | { kind: "settled"; text: string; resend: boolean }
  | { kind: "error"; text: string };

/** 閉じた後に「送信」のボタンの横に出す、送信の状態（docs/spec.md の 3.4）。stalled は状態を読めずに止まったとき */
export type SendActivity = "sending" | "success" | "failure" | "unknown" | "stalled";

const POLL_MS = 1500;

/** Orthanc の仕事の状態の、画面の言葉（docs/spec.md の 2.2） */
export const SEND_STATE_TEXT: Record<JobView["state"], string> = {
  Pending: "送信待ち",
  Running: "送信中",
  Success: "送信完了",
  Failure: "送信失敗",
  Paused: "一時停止中",
  Retry: "再試行待ち",
};

const isDone = (job: JobView | null | undefined) => job?.state === "Success" || job?.state === "Failure";

/** 送信の状態を、閉じた後の印にする */
function activityOf(phase: Phase): SendActivity | null {
  if (phase.kind === "sending") return "sending";
  if (phase.kind === "unknown") return "unknown";
  if (phase.kind !== "job") return null;
  // 状態を読めずに止まっている（「再読み込み」を押すまで読まない）：送信中と見せない
  if (phase.readError) return "stalled";
  if (phase.job?.state === "Success") return "success";
  if (phase.job?.state === "Failure") return "failure";
  return "sending";
}

/** 送る画面（開閉は呼ぶ側の PacsActions が持つ。ボタンもそちら） */
export function SendPanel({
  study,
  screen,
  open,
  panelId,
  onClose,
  onStatus,
}: {
  study: StudyView;
  screen: ScreenInfo;
  open: boolean;
  panelId: string;
  onClose: () => void;
  /** 送信の状態が変わったとき（閉じた後も「送信」のボタンの横に出すため） */
  onStatus?: (activity: SendActivity | null) => void;
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

  // 仕事の状態を、終わるまで読む（閉じていても読む）。読めなかったときは token と要求の ID を残したまま止め、「再読み込み」を出す
  useEffect(() => {
    if (phase.kind !== "job" || phase.readError) return;
    if (isDone(phase.job)) return;
    timer.current = window.setTimeout(() => {
      getJson<JobView>(`/api/jobs/${encodeURIComponent(phase.token)}`).then(
        (job) => setPhase((p) => (p.kind === "job" && p.token === phase.token ? { ...p, job, readError: undefined } : p)),
        (e: Error) => setPhase((p) => (p.kind === "job" && p.token === phase.token ? { ...p, readError: e.message } : p)),
      );
    }, phase.job ? POLL_MS : 0);
    return () => window.clearTimeout(timer.current);
  }, [phase]);

  // 閉じた後の印のために、送信の状態を呼ぶ側へ知らせる
  useEffect(() => {
    onStatus?.(activityOf(phase));
  }, [phase, onStatus]);

  // 行が替わったら、送る画面を閉じる（別の検査を送らないように）：呼ぶ側が key に検査の UID を付けて、作り直す

  if (!screen.can.send || !uid) return null;

  const chosen = modalities?.find((m) => m.id === target);
  const hasTargets = modalities !== null && modalities.length > 0;

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
      else if (r.outcome === "failed") setPhase({ kind: "settled", text: "送信されていませんでした。再送できます", resend: true });
      else if (r.outcome === "delivered") setPhase({ kind: "settled", text: "送信済み（管理者が確認）", resend: false });
      else setPhase({ kind: "unknown", requestId });
    } catch (e) {
      // 確かめの通信が失敗しても、結果不明のまま要求の ID と確かめの道を残す
      setPhase({ kind: "unknown", requestId, checkError: (e as Error).message });
    }
  }

  /** 管理者が送り先で確かめた結果を、記録に足す（照らし合わせ） */
  async function resolve(requestId: string, delivered: boolean, note: string) {
    const result = await postJson(`/api/studies/${encodeURIComponent(uid)}/send/resolve`, { requestId, delivered, note }, screen.csrfToken);
    if (result.ok) {
      setPhase(
        delivered
          ? { kind: "settled", text: "送信済みとして記録しました", resend: false }
          : { kind: "settled", text: "未送信として記録しました。再送できます", resend: true },
      );
    } else setPhase({ kind: "unknown", requestId, checkError: errorText(result) });
  }

  // 結果不明の間・送っている間は送れない（新しい要求の ID で重ねて送らない）
  const inFlight = phase.kind === "sending" || phase.kind === "unknown" || (phase.kind === "job" && !isDone(phase.job));
  // 送信を受け付けた後（終わった後も）は、同じ画面から重ねて送らない。送信先を選び直すと、新しい送信の確かめの画面に戻る
  const sent = phase.kind !== "idle" && phase.kind !== "error";
  // 終わった後は「再送信…」で確かめの画面に戻せる（送信完了・送信失敗・再送できると分かったとき）
  const canResend = (phase.kind === "job" && isDone(phase.job)) || (phase.kind === "settled" && phase.resend);
  // Orthanc が送信を受け付けた後（ジョブの段）は、閉じても送信は続く（結果不明のときは、その知らせの中に次にすることを出す）。
  // 受け付けの前（送信を開始している間）は閉じさせない：断られた（400・403・409 など）ときに、その知らせを見せるため
  const continuesNote = phase.kind === "job" && !isDone(phase.job);

  /** 閉じる：送り終えた・断られた画面は片付ける（開き直すと新しい送信の確かめの画面）。送っている間・結果不明の間は残す */
  function close() {
    if (!inFlight) setPhase({ kind: "idle" });
    onClose();
  }

  return (
    <>
      {open && (
        <ConfirmPanel
          id={panelId}
          label="検査の送信"
          testId="send-panel"
          confirmTestId="send-confirm"
          focusReady={hasTargets}
          summary={
            hasTargets
              ? {
                  name: study.patientName ?? "",
                  patientId: study.patientId ?? "",
                  birthLine: formatBirthLine(study.patientBirthDate, study.patientSex, study.studyDate),
                }
              : undefined
          }
          details={
            hasTargets && (
              <>
                <label className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-label">送信先</span>
                  <Select
                    size="sm"
                    value={target}
                    disabled={inFlight}
                    onChange={(e) => {
                      setTarget(e.target.value);
                      // 送信先を選び直したら、新しい送信の確かめの画面に戻る
                      if (!inFlight) setPhase({ kind: "idle" });
                    }}
                    data-testid="send-modality"
                  >
                    {modalities?.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}（AE: {m.aet}）
                      </option>
                    ))}
                  </Select>
                </label>
                {/* 確かめの画面：送る検査と送り先を2行の表に並べる */}
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  <dt className="text-xs text-label">送信する検査</dt>
                  <dd>
                    {formatSlashDate(study.studyDate)} {study.modalities?.join("・")}／{study.instanceCount ?? "—"} 画像
                  </dd>
                  <dt className="text-xs text-label">送信先</dt>
                  <dd className="font-bold text-value">
                    {chosen?.id}（{chosen?.aet}）
                  </dd>
                </dl>
              </>
            )
          }
        >
          {loadError && (
            <p role="alert" className="text-danger">
              {loadError}
            </p>
          )}
          {modalities && modalities.length === 0 && <p className="text-label">送信先が登録されていません（Orthanc の設定で登録します）</p>}
          <SendStatus
            phase={phase}
            timeZone={screen.timeZone}
            instanceCount={study.instanceCount}
            onCheck={(id) => void check(id)}
            onReread={() => setPhase((p) => (p.kind === "job" ? { ...p, readError: undefined } : p))}
            onResolve={screen.can.reconcile ? (id, delivered, note) => void resolve(id, delivered, note) : undefined}
          />
          {hasTargets && (
            <ConfirmActions
              confirmLabel="送信する"
              confirmTestId="send-submit"
              confirmIcon={<Send aria-hidden />}
              confirmDisabled={!target}
              // 送信を始めたら（受け付けた後・結果不明を含む）実行のボタンを外し、重ねて送らない
              hideConfirm={sent}
              onConfirm={() => void send()}
              cancelLabel={sent ? "閉じる" : "キャンセル"}
              cancelTestId="send-close"
              cancelDisabled={phase.kind === "sending"}
              onCancel={close}
              extra={
                canResend && (
                  // 確かめの画面に戻す（送るのは、そこで「送信する」を押したとき。新しい要求の ID になる）
                  <Button type="button" size="sm" variant="outline" onClick={() => setPhase({ kind: "idle" })} data-testid="send-again">
                    <RotateCcw aria-hidden />
                    再送信…
                  </Button>
                )
              }
              note={
                continuesNote && (
                  <span className="text-xs text-label" data-testid="send-continues">
                    閉じても送信は続きます
                  </span>
                )
              }
            />
          )}
        </ConfirmPanel>
      )}
    </>
  );
}

/** 時刻だけ（`10:32:15`）。終わった時刻が無ければ、いまの時刻 */
function timeOf(iso: string | null | undefined, timeZone: string): string {
  const at = iso && formatDateTimeIn(iso, timeZone, { seconds: true }) ? iso : new Date().toISOString();
  return formatDateTimeIn(at, timeZone, { seconds: true }).split(" ")[1] ?? "";
}

/** 状態の枠（送っている間・完了・失敗で、地の色と印を変える。色だけに頼らず、印と文字を添える） */
const BOX = "rounded-md border px-3 py-2";

/** 送っている間の進みの帯。進みの割合が分かれば、その長さ。分からなければ流れる帯 */
function SendProgress({ progress }: { progress: number | null }) {
  if (progress === null) return <ProgressBar label="送信中" />;
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <div
      role="progressbar"
      aria-label="送信中"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className="relative h-1 w-full overflow-hidden rounded-full bg-hover"
      data-testid="send-progress"
    >
      <div className="absolute inset-y-0 left-0 bg-ring transition-[width]" style={{ width: `${value}%` }} />
    </div>
  );
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
    // 押した直後から出す（0.3 秒を待たない。押したことが分かるように）
    return (
      <div role="status" className={cn(BOX, "space-y-1.5 border-ring bg-background")} data-testid="send-status" data-state="Starting">
        <p className="flex items-center gap-1.5 font-bold text-value">
          <Spinner />
          送信を開始しています…（{phase.target.id}（{phase.target.aet}））
        </p>
        <SendProgress progress={null} />
      </div>
    );
  }
  if (phase.kind === "error") {
    return (
      <p role="alert" className={cn(BOX, "flex items-center gap-1.5 border-danger bg-background text-danger")} data-testid="send-status" data-state="Error">
        <XCircle aria-hidden className="size-4 shrink-0" />
        {phase.text}
      </p>
    );
  }
  if (phase.kind === "settled") {
    return (
      <p role="status" className={cn(BOX, "border-border bg-background")} data-testid="send-status" data-state="Settled">
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
      <div role="alert" className={cn(BOX, "space-y-1 border-danger bg-background")} data-testid="send-status" data-state={job?.state ?? "Accepted"}>
        <p className="text-danger">状態を取得できませんでした（{phase.readError}）。再送信せずに「再読み込み」を押してください</p>
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
      <p role="status" className={cn(BOX, "flex items-center gap-1.5 border-success bg-background font-bold text-success")} data-testid="send-status" data-state="Success">
        <CheckCircle2 aria-hidden className="size-4 shrink-0" />
        <span data-testid="send-result">
          {SEND_STATE_TEXT.Success}：{to} へ {instanceCount ?? "—"} 画像（{timeOf(job.completionTime, timeZone)}）
        </span>
      </p>
    );
  }
  if (job?.state === "Failure") {
    return (
      <p role="alert" className={cn(BOX, "flex items-center gap-1.5 border-danger bg-background font-bold text-danger")} data-testid="send-status" data-state="Failure">
        <XCircle aria-hidden className="size-4 shrink-0" />
        <span data-testid="send-result">
          {SEND_STATE_TEXT.Failure}
          {job.errorDescription ? `：${job.errorDescription}` : ""}（{to}・{timeOf(job.completionTime, timeZone)}）
        </span>
      </p>
    );
  }
  // 送っている間（受け付けた・送信待ち・送信中・一時停止中・再試行待ち）
  const text = job ? SEND_STATE_TEXT[job.state] : "送信を受け付けました";
  return (
    <div role="status" className={cn(BOX, "space-y-1.5 border-ring bg-background")} data-testid="send-status" data-state={job?.state ?? "Accepted"}>
      <p className="flex items-center gap-1.5 font-bold text-value">
        <Spinner />
        {text}
        {job?.state === "Running" ? `（${job.progress}%）` : ""}
        <span className="font-normal text-label">：{to} へ</span>
      </p>
      <SendProgress progress={job?.state === "Running" ? job.progress : null} />
    </div>
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
    <div role="alert" className={cn(BOX, "space-y-1 border-danger bg-background")} data-testid="send-status" data-state="Unknown">
      <p className="text-danger">送信結果を確認できません。再送信せずに状態を確認してください。確認が終わるまで、同じ送信先へは送信できません</p>
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
              className="h-7 w-full rounded-md border border-border-input bg-background px-2 text-sm text-value"
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
