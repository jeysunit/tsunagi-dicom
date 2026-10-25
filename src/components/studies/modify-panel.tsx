"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { ActionButton, PendingText } from "@/components/ui/pending";
import { Tabs } from "@/components/ui/tabs";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { handleAuthStatus, NETWORK_ERROR_MESSAGE } from "@/lib/client/api";
import { errorText, postJson, type PostResult } from "@/lib/client/post-json";
import { checkFieldValue, FIELD_LABELS, type CorrectionField, type CorrectionKind, type CorrectionValues } from "@/lib/correction-fields";
import type { StudyView } from "@/lib/fields";
import { formatSlashDate } from "@/lib/format/japanese-date";

// 患者・検査の値の修正（docs/spec.md の 3.5。段 6）。一般と管理者。窓は2つに分ける。
// - 患者情報修正：患者ID・氏名・生年月日・性別・受付番号。UID を保つ。氏名・生年月日・性別は同じ患者ID の全部の検査に、
//   患者ID の付け替えと受付番号は、この検査だけに当てる（範囲は確かめの画面に出す）。
// - 検査情報修正：検査日・検査名。直した新しい検査を作り、元の検査は残す。
// 入力 → 確認（BFF が Orthanc から読んだ前と後の値・当てる検査・付け替え先の患者の値）→ 修正理由 → 修正する、の順に進む。
// 大事な操作なので、BFF が再認証を求めたら、パスワードを入れてから続ける。答えが分からなければ「結果不明」と要求ID を出し、
// もう一度修正させずに、状態を確認する道と、管理者が確かめて解く道だけを出す。

/** いまの値（BFF が Orthanc から読んだもの。一覧の行の値ではない） */
interface Current {
  orthancId: string;
  values: Record<CorrectionField, string>;
  mixed: string[];
}

interface Candidate {
  orthancId: string;
  patientId: string;
  patientName: string;
  studyDate: string;
  instanceCount: number;
}

interface Preview {
  confirmToken: string;
  scope: "patient" | "reassign" | "accession" | "content";
  orthancId: string;
  fields: Record<string, { before: string; after: string }>;
  studies: {
    studyInstanceUid: string;
    studyDate: string;
    studyDescription: string;
    accessionNumber: string;
    instanceCount: number;
    mixed: string[];
    /** 患者情報修正：この検査の、直す項目の修正前の値 */
    before?: Record<string, string>;
  }[];
  target?: { exists: boolean; PatientName?: string; PatientBirthDate?: string; PatientSex?: string };
}

type Phase =
  | { kind: "edit" }
  | { kind: "busy" }
  | { kind: "reauth"; requestId: string; error?: string }
  | { kind: "done"; text: string }
  | { kind: "unknown"; requestId: string; partial?: boolean; note?: string; writeIds?: string[]; hl7?: boolean }
  | { kind: "error"; text: string };

const SEX_LABELS: Record<string, string> = { "": "（なし）", M: "M（男性）", F: "F（女性）", O: "O（その他）" };

/** DICOM の値を画面に出す形（日付は yyyy/MM/dd、氏名は「=」の組を「／」で、空は「（なし）」） */
function shown(field: string, value: string): string {
  if (value === "") return "（なし）";
  if (field === "PatientBirthDate" || field === "StudyDate") return formatSlashDate(value);
  if (field === "PatientSex") return SEX_LABELS[value] ?? value;
  if (field === "PatientName") return value.split("=").filter(Boolean).join("／");
  return value;
}

interface PendingItem {
  /** 値の修正の要求ID（HL7 の書き換えは無い） */
  requestId: string | null;
  kind: "attribute" | "content" | "hl7";
  writeIds: string[];
}

/** この検査の、管理者の確かめを待っている修正（読めなければ空。新しい修正は BFF が断る） */
async function readPending(uid: string): Promise<PendingItem[]> {
  try {
    const res = await fetch(`/api/studies/${encodeURIComponent(uid)}/modify`, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) {
      handleAuthStatus(res.status);
      return [];
    }
    const body = (await res.json()) as { pending?: PendingItem[] };
    return Array.isArray(body.pending) ? body.pending : [];
  } catch {
    return [];
  }
}

async function readCurrent(uid: string, orthancId?: string): Promise<{ current?: Current; candidates?: Candidate[]; error?: string }> {
  const query = orthancId ? `?${new URLSearchParams({ orthancId })}` : "";
  try {
    const res = await fetch(`/api/studies/${encodeURIComponent(uid)}/modify/preview${query}`, { credentials: "same-origin", cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as Partial<Current> & { error?: string; candidates?: Candidate[] };
    if (res.ok) return { current: body as Current };
    handleAuthStatus(res.status);
    return { candidates: body.candidates, error: body.error ?? `読み込めませんでした（${res.status}）` };
  } catch {
    return { error: NETWORK_ERROR_MESSAGE };
  }
}

export function ModifyPanel({
  study,
  screen,
  panelId,
  onClose,
  onModified,
}: {
  study: StudyView;
  screen: ScreenInfo;
  panelId: string;
  onClose: () => void;
  /** 修正できたあと（一覧と詳細を読み直す） */
  onModified: () => void;
}) {
  const uid = study.studyInstanceUid ?? "";
  const [current, setCurrent] = useState<Current | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // この検査の、管理者の確かめを待っている修正（窓を閉じた・頁を読み直した後も、状態の確認と解除の道へ戻す）
  const [pending, setPending] = useState<PendingItem[]>([]);
  const fetchCurrent = useCallback((orthancId?: string) => {
    void readPending(uid).then(setPending);
    void readCurrent(uid, orthancId).then((r) => {
      if (r.current) {
        setCurrent(r.current);
        setCandidates(null);
        setLoadError(null);
      } else {
        setCandidates(r.candidates ?? null);
        setLoadError(r.error ?? null);
      }
    });
  }, [uid]);
  useEffect(() => fetchCurrent(), [fetchCurrent]);
  /** 同じ UID の検査の中から選んで、読み直す */
  function load(orthancId: string) {
    setCurrent(null);
    setLoadError(null);
    fetchCurrent(orthancId);
  }

  return (
    <div id={panelId} role="group" aria-label="修正" className="mt-2 space-y-2 rounded-md border border-border bg-surface p-3" data-testid="modify-panel">
      {!current && !loadError && (
        <p className="min-h-5">
          <PendingText pending>いまの値を読み込んでいます…</PendingText>
        </p>
      )}
      {loadError && !candidates && (
        <p role="alert" className="text-danger" data-testid="modify-load-error">
          {loadError}
        </p>
      )}
      {candidates && (
        // 同じ StudyInstanceUID の検査が複数ある（付け替えの後に、元の患者ID で同じ検査の画像が届いたときなど）。修正する検査を選ぶ
        <div className="space-y-1" data-testid="modify-candidates">
          <p className="text-label">{loadError}</p>
          <ul className="space-y-1">
            {candidates.map((c) => (
              <li key={c.orthancId}>
                <Button type="button" size="sm" variant="outline" onClick={() => load(c.orthancId)}>
                  {c.patientId} {c.patientName.split("=").filter(Boolean).join("／")}／{formatSlashDate(c.studyDate)}／{c.instanceCount} 画像
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {current && pending[0] && (
        // 待っている修正があれば、新しい修正の欄の代わりに、その修正の状態の確認と解除の道を出す
        <CorrectionForm
          key={pending[0].requestId ?? pending[0].writeIds.join(",")}
          kind={pending[0].kind === "content" ? "content" : "attribute"}
          uid={uid}
          current={current}
          screen={screen}
          onClose={onClose}
          onModified={() => {
            onModified();
            fetchCurrent(current.orthancId);
          }}
          initialPhase={{ kind: "unknown", requestId: pending[0].requestId ?? "", writeIds: pending[0].writeIds, hl7: pending[0].kind === "hl7" }}
        />
      )}
      {current && !pending[0] && (
        <>
          {current.mixed.length > 0 && (
            <p className="text-sm text-danger" data-testid="modify-mixed">
              画像ごとに値が揃っていない項目があります（{current.mixed.map((f) => FIELD_LABELS[f as CorrectionField] ?? f).join("・")}）。修正すると、全部の画像が同じ値になります。
            </p>
          )}
          <Tabs
            label="修正の種類"
            items={[
              {
                id: "attribute",
                label: "患者情報修正",
                content: <CorrectionForm kind="attribute" uid={uid} current={current} screen={screen} onClose={onClose} onModified={onModified} />,
              },
              {
                id: "content",
                label: "検査情報修正",
                content: <CorrectionForm kind="content" uid={uid} current={current} screen={screen} onClose={onClose} onModified={onModified} />,
              },
            ]}
          />
        </>
      )}
    </div>
  );
}

/** 窓ごとの入力の欄（患者情報修正：患者ID・氏名の3つの組・生年月日・性別・受付番号。検査情報修正：検査日・検査名） */
const NAME_PARTS = [
  { label: "英字氏名", index: 0 },
  { label: "氏名", index: 1 },
  { label: "カナ", index: 2 },
] as const;

function CorrectionForm({
  kind,
  uid,
  current,
  screen,
  onClose,
  onModified,
  initialPhase,
}: {
  kind: CorrectionKind;
  uid: string;
  current: Current;
  screen: ScreenInfo;
  onClose: () => void;
  onModified: () => void;
  /** 待っている修正を開き直したとき（状態の確認と解除の道から始める） */
  initialPhase?: Phase;
}) {
  const fields: readonly CorrectionField[] = kind === "attribute"
    ? ["PatientID", "PatientName", "PatientBirthDate", "PatientSex", "AccessionNumber"]
    : ["StudyDate", "StudyDescription"];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f, current.values[f] ?? ""])));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<{ field: string | null; text: string } | null>(null);
  const [reason, setReason] = useState("");
  const [phase, setPhase] = useState<Phase>(initialPhase ?? { kind: "edit" });
  const [checking, setChecking] = useState(false);
  const [authing, setAuthing] = useState(false);
  const base = `/api/studies/${encodeURIComponent(uid)}/modify`;

  /** 変えた項目だけ（変えていない項目は送らない。BFF は、要求に無い項目を変えない） */
  const changed = (): CorrectionValues => Object.fromEntries(fields.filter((f) => values[f] !== (current.values[f] ?? "")).map((f) => [f, values[f]!]));
  const nameParts = (values.PatientName ?? "").split("=");
  const setNamePart = (index: number, part: string) => {
    const parts = [nameParts[0] ?? "", nameParts[1] ?? "", nameParts[2] ?? ""];
    parts[index] = part;
    // 後ろの空の組は落とす（「山田^太郎==」を「山田^太郎」にする）
    while (parts.length > 1 && parts.at(-1) === "") parts.pop();
    set("PatientName", parts.join("="));
  };
  function set(field: string, value: string) {
    setValues((v) => ({ ...v, [field]: value }));
    setPreview(null);
    setProblem(null);
  }

  async function check(event: React.FormEvent) {
    event.preventDefault();
    const proposed = changed();
    if (Object.keys(proposed).length === 0) {
      setProblem({ field: null, text: "変更された項目がありません" });
      return;
    }
    for (const [field, value] of Object.entries(proposed)) {
      const message = checkFieldValue(field as CorrectionField, value ?? "");
      if (message) {
        setProblem({ field, text: message });
        return;
      }
    }
    setChecking(true);
    const res = await postJson(`${base}/preview`, { kind, values: proposed, orthancId: current.orthancId }, screen.csrfToken);
    setChecking(false);
    if (!res.ok) {
      handleAuthStatus(res.status);
      setProblem({ field: typeof res.data.field === "string" ? res.data.field : null, text: errorText(res) });
      return;
    }
    setPreview(res.data as unknown as Preview);
  }

  function settle(result: PostResult, requestId: string) {
    if (result.status === 403 && result.data.problems?.includes("reauth_required")) {
      setPhase({ kind: "reauth", requestId });
      return;
    }
    const outcome = result.data.outcome;
    if (outcome === "modified") {
      setPhase({ kind: "done", text: `修正しました（${Number(result.data.total ?? 1)} 件の検査）` });
      onModified();
    } else if (outcome === "created") {
      setPhase({ kind: "done", text: "修正しました。修正した検査を新しく作りました（元の検査は残っています）" });
      onModified();
    } else if (outcome === "partial" || outcome === "unknown" || result.status === 0 || result.status === 202 || (result.status >= 500 && outcome !== "failed")) {
      setPhase({ kind: "unknown", requestId, partial: outcome === "partial", note: typeof result.data.error === "string" ? result.data.error : undefined });
      if (outcome === "partial") onModified();
    } else {
      // 409（確認の後に検査が変わった・結果不明の書き換えがある）は、確認からやり直す
      if (result.status === 409) setPreview(null);
      setPhase({ kind: "error", text: errorText(result) });
    }
  }

  const postModify = (requestId: string) =>
    postJson(base, { requestId, kind, values: changed(), reason, confirmToken: preview?.confirmToken ?? "", orthancId: current.orthancId }, screen.csrfToken);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const requestId = crypto.randomUUID();
    setPhase({ kind: "busy" });
    settle(await postModify(requestId), requestId);
  }

  async function reauth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase.kind !== "reauth") return;
    const form = new FormData(event.currentTarget);
    setAuthing(true);
    const res = await postJson("/api/auth/reauth", { password: form.get("password") }, screen.csrfToken);
    setAuthing(false);
    if (res.data.next) {
      window.location.assign(res.data.next);
      return;
    }
    if (!res.ok) {
      setPhase({ ...phase, error: errorText(res) });
      return;
    }
    // 同じ要求ID で送り直す（再認証で断られた要求は「求めた」と数えていないので、Orthanc を呼ぶのはこの1回）
    const { requestId } = phase;
    setPhase({ kind: "busy" });
    settle(await postModify(requestId), requestId);
  }

  async function status(requestId: string) {
    const res = await fetch(`${base}?${new URLSearchParams({ requestId })}`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    if (!res) {
      setPhase({ kind: "unknown", requestId, note: NETWORK_ERROR_MESSAGE });
      return;
    }
    handleAuthStatus(res.status);
    const body = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string; unresolvedWriteIds?: string[] };
    if (body.outcome === "modified" || body.outcome === "created") {
      setPhase({ kind: "done", text: "修正しました" });
      onModified();
    } else if (body.outcome === "failed") {
      setPhase({ kind: "error", text: "修正されていません" });
    } else {
      setPhase({ kind: "unknown", requestId, partial: body.outcome === "partial", note: body.error, writeIds: body.unresolvedWriteIds });
    }
  }

  async function resolve(event: React.FormEvent<HTMLFormElement>, requestId: string, writeIds: readonly string[]) {
    event.preventDefault();
    const note = String(new FormData(event.currentTarget).get("note") ?? "");
    // 検査情報修正は要求ID で、患者情報修正は書き換えの ID ごとに（HL7 の書き換えと同じ道で）解く
    const results = kind === "content"
      ? [await postJson(`${base}/resolve`, { requestId, note }, screen.csrfToken)]
      : await Promise.all(writeIds.map((writeId) => postJson("/api/hl7/resolve", { writeId, note }, screen.csrfToken)));
    const failed = results.find((r) => !r.ok);
    if (failed) {
      setPhase({ kind: "unknown", requestId, note: errorText(failed), writeIds: [...writeIds] });
      return;
    }
    setPhase({ kind: "done", text: "確認済みとして解除しました。値を確認してから、必要なら修正し直してください" });
    onModified();
  }

  const busy = phase.kind === "busy";
  const editing = phase.kind === "edit" || phase.kind === "error";
  return (
    <div className="space-y-3 pt-2" data-testid={`modify-${kind}`}>
      {editing && (
        <form onSubmit={(e) => void check(e)} className="grid max-w-xl grid-cols-1 gap-2 sm:grid-cols-2" data-testid={`modify-${kind}-form`}>
          {kind === "attribute" && (
            <>
              <Field label="患者ID" hint="変えると、この検査だけを別の患者へ付け替えます">
                <Input value={values.PatientID ?? ""} onChange={(e) => set("PatientID", e.target.value)} data-testid="modify-PatientID" />
              </Field>
              <Field label="受付番号" hint="この検査だけに当てます">
                <Input value={values.AccessionNumber ?? ""} onChange={(e) => set("AccessionNumber", e.target.value)} data-testid="modify-AccessionNumber" />
              </Field>
              {NAME_PARTS.map(({ label, index }) => (
                <Field key={label} label={label} hint={index === 0 ? "姓と名の間は「^」。同じ患者IDの全部の検査に当てます" : undefined}>
                  <Input value={nameParts[index] ?? ""} onChange={(e) => setNamePart(index, e.target.value)} data-testid={`modify-PatientName-${index}`} />
                </Field>
              ))}
              <Field label="生年月日" hint="YYYYMMDD">
                <Input value={values.PatientBirthDate ?? ""} onChange={(e) => set("PatientBirthDate", e.target.value)} inputMode="numeric" data-testid="modify-PatientBirthDate" />
              </Field>
              <Field label="性別">
                <select
                  value={values.PatientSex ?? ""}
                  onChange={(e) => set("PatientSex", e.target.value)}
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-value"
                  data-testid="modify-PatientSex"
                >
                  {Object.entries(SEX_LABELS).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          {kind === "content" && (
            <>
              <Field label="検査日" hint="YYYYMMDD">
                <Input value={values.StudyDate ?? ""} onChange={(e) => set("StudyDate", e.target.value)} inputMode="numeric" data-testid="modify-StudyDate" />
              </Field>
              <Field label="検査名">
                <Input value={values.StudyDescription ?? ""} onChange={(e) => set("StudyDescription", e.target.value)} data-testid="modify-StudyDescription" />
              </Field>
            </>
          )}
          {problem && (
            <p role="alert" className="text-sm text-danger sm:col-span-2" data-testid="modify-problem">
              {problem.field ? `${FIELD_LABELS[problem.field as CorrectionField] ?? problem.field}：` : ""}
              {problem.text}
            </p>
          )}
          {!preview && (
            <div className="flex gap-2 sm:col-span-2">
              <ActionButton type="submit" size="sm" variant="outline" pending={checking} data-testid={`modify-${kind}-check`}>
                確認
              </ActionButton>
              <Button type="button" size="sm" variant="outline" onClick={onClose}>
                キャンセル
              </Button>
            </div>
          )}
        </form>
      )}
      {preview && editing && (
        <form onSubmit={(e) => void submit(e)} className="space-y-2" data-testid="modify-confirm">
          <table className="text-sm">
            <thead>
              <tr className="text-xs text-label">
                <th className="pr-4 text-left font-normal">項目</th>
                <th className="pr-4 text-left font-normal">修正前</th>
                <th className="text-left font-normal">修正後</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(preview.fields).map(([field, v]) => (
                <tr key={field} data-testid={`modify-row-${field}`}>
                  <td className="pr-4 text-label">{FIELD_LABELS[field as CorrectionField] ?? field}</td>
                  <td className="pr-4 text-value">{shown(field, v.before)}</td>
                  <td className="font-bold text-value">{shown(field, v.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.studies.some((s) => Object.entries(s.before ?? {}).some(([f, v]) => v !== preview.fields[f]?.before)) && (
            // 同じ患者IDの検査どうしで修正前の値が違う（取り違え・前の修正の途中で止まったなど）。検査ごとの値を並べる
            <div className="space-y-1" data-testid="modify-studies">
              <p className="text-sm text-danger">検査ごとに修正前の値が違います。全部の検査が修正後の値になります。</p>
              <table className="text-sm">
                <thead>
                  <tr className="text-xs text-label">
                    <th className="pr-4 text-left font-normal">検査日</th>
                    <th className="pr-4 text-left font-normal">検査名</th>
                    {Object.keys(preview.fields).map((f) => (
                      <th key={f} className="pr-4 text-left font-normal">{FIELD_LABELS[f as CorrectionField] ?? f}（修正前）</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.studies.map((s) => (
                    <tr key={s.studyInstanceUid}>
                      <td className="pr-4 text-value">{formatSlashDate(s.studyDate)}</td>
                      <td className="pr-4 text-value">{s.studyDescription}</td>
                      {Object.keys(preview.fields).map((f) => (
                        <td key={f} className="pr-4 text-value">{shown(f, s.before?.[f] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-sm text-value" data-testid="modify-scope">
            {preview.scope === "patient" && `同じ患者IDの検査 ${preview.studies.length} 件の、全部の画像に当てます。`}
            {preview.scope === "reassign" && (preview.target?.exists
              ? "この検査だけを、付け替え先の患者へ移します。氏名・生年月日・性別は、付け替え先の患者の値にそろえます。"
              : "この検査だけを、新しい患者IDへ移します。")}
            {preview.scope === "accession" && "この検査だけに当てます。"}
            {preview.scope === "content" && "修正した検査を、新しい StudyInstanceUID で作ります。元の検査は残ります（元の検査を消すときは、削除を使います）。"}
          </p>
          {preview.studies.some((s) => s.mixed.length > 0) && (
            <p className="text-sm text-danger">画像ごとに値が揃っていない検査があります。修正すると、直す項目は全部の画像で同じ値になります。</p>
          )}
          <label className="block space-y-1">
            <span className="text-xs text-label">修正理由（必須・操作ログに記録）</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
              maxLength={500}
              required
              rows={2}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-value"
              data-testid="modify-reason"
            />
          </label>
          <div className="flex items-center gap-2">
            <ActionButton type="submit" size="sm" pending={busy} disabled={reason.trim() === ""} data-testid="modify-submit">
              修正する
            </ActionButton>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setPreview(null)}>
              キャンセル
            </Button>
          </div>
        </form>
      )}
      {phase.kind === "reauth" && (
        <form onSubmit={(e) => void reauth(e)} aria-label="再認証" className="max-w-sm space-y-2" data-testid="modify-reauth">
          <p className="text-label">修正にはパスワードの再入力が必要です</p>
          <Input name="password" type="password" autoComplete="current-password" aria-label="パスワード" required />
          {phase.error && (
            <p role="alert" className="text-sm text-danger">
              {phase.error}
            </p>
          )}
          <div className="flex gap-2">
            <ActionButton type="submit" size="sm" pending={authing}>
              認証して続行
            </ActionButton>
            <Button type="button" size="sm" variant="outline" disabled={authing} onClick={() => setPhase({ kind: "edit" })}>
              キャンセル
            </Button>
          </div>
        </form>
      )}
      {busy && (
        <p>
          <PendingText pending>修正中…</PendingText>
        </p>
      )}
      {phase.kind === "done" && (
        <p role="status" className="font-bold text-value" data-testid="modify-status">
          {phase.text}
        </p>
      )}
      {phase.kind === "unknown" && (
        <div role="alert" className="space-y-1" data-testid="modify-status">
          <p className="text-danger">
            {phase.hl7
              ? "この検査に、結果不明のHL7の更新があります。管理者が確認するまで、修正はできません"
              : phase.partial
                ? "一部だけが修正されました。管理者が確認するまで、修正はできません"
                : "修正の結果を確認できません。再実行せずに状態を確認してください"}
          </p>
          {phase.note && <p className="text-sm text-label">{phase.note}</p>}
          {phase.requestId && (
            <>
              <p className="font-mono text-xs text-label">要求ID {phase.requestId}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void status(phase.requestId)}>
                状態を確認
              </Button>
            </>
          )}
          {screen.can.reconcile && (kind === "content" || (phase.writeIds?.length ?? 0) > 0) && (
            <form onSubmit={(e) => void resolve(e, phase.requestId, phase.writeIds ?? [])} aria-label="結果不明の修正の解除" className="space-y-1 pt-2" data-testid="modify-resolve">
              <p className="text-xs text-label">管理者：Orthanc のジョブと画像の値を確認してから解除してください</p>
              <textarea
                name="note"
                required
                maxLength={500}
                rows={2}
                aria-label="確認内容"
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-value"
              />
              <Button type="submit" size="sm" variant="outline">
                確認済みとして解除
              </Button>
            </form>
          )}
        </div>
      )}
      {phase.kind === "error" && (
        <p role="alert" className="text-danger" data-testid="modify-error">
          {phase.text}
        </p>
      )}
    </div>
  );
}
