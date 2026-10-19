"use client";

import { useQuery } from "@tanstack/react-query";
import { Bookmark, Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { Thumbnail } from "@/components/studies/thumbnail";
import { ViewerMenu } from "@/components/studies/viewer-menu";
import type { DicomValueRow } from "@/lib/all-values";
import { getJson } from "@/lib/client/api";
import { getDetailOpen, getServerDetailOpen, setDetailOpen, subscribeDetailOpen } from "@/lib/client/detail-open";
import { errorText, postJson } from "@/lib/client/post-json";
import type { SeriesView, StudyView } from "@/lib/fields";
import { formatBirthLine, formatDicomTime, formatSlashDate, sexLabel } from "@/lib/format/japanese-date";
import type { StateFlag } from "@/lib/study-state";
import { cn } from "@/lib/utils";

// 詳細のパネル（docs/spec.md の 3.1）。一覧の下の場所に出す。行を選ぶと、動きの遅れ無しに替わる（一覧の行の値ですぐ描き、
// シリーズの並びは画面の API から後で足す）。見出しは 1〜2 行（氏名・かな・患者 ID・生年月日と和暦・年齢・性別／検査日・
// モダリティ・検査の記述）、その下にシリーズのサムネイルを横に 1 列（横にスクロール。まわりだけ暗い地）。
// ほかの値（検査の情報・患者の情報の 2 列と UID）は「すべての項目」を押したときに開く（開閉はこの端末のブラウザに覚える）。
// 値は `…` で切らずに折り返す。UID は行の幅いっぱいに、小さく等幅で出す。

export interface StudyDetailData {
  study: StudyView;
  series: SeriesView[];
}

export const detailKey = (uid: string) => ["study", uid] as const;
// UID は画像サーバーから来た値なので、path に入れるときは符号化する（BFF の側でも形を確かめる）
export const fetchDetail = (uid: string) => getJson<StudyDetailData>(`/api/studies/${encodeURIComponent(uid)}`);

function Item({ label, value, wide }: { label: string; value: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="text-xs text-label">{label}</dt>
      <dd className="font-bold break-words text-value">{value === "" || value == null ? <span className="font-normal text-label">—</span> : value}</dd>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-label={`${label}をコピー`}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {done ? <Check aria-hidden /> : <Copy aria-hidden />}
    </Button>
  );
}

/** StudyInstanceUID・SeriesInstanceUID：行の幅いっぱいに 0.75rem・等幅・控えめの色、コピーのボタン付き */
function UidLine({ label, uid }: { label: string; uid: string }) {
  return (
    <div className="flex items-center gap-2" data-testid="uid-line">
      <span className="shrink-0 text-xs text-label">{label}</span>
      <code className="min-w-0 flex-1 font-mono text-[0.75rem] break-all text-label">{uid}</code>
      <CopyButton text={uid} label={label} />
    </div>
  );
}

const STATE_BUTTONS: { flag: StateFlag; on: string; off: string; can: keyof ScreenInfo["can"] }[] = [
  { flag: "inspected", on: "検像済", off: "未検像", can: "inspect" },
  { flag: "read", on: "既読", off: "未読", can: "readStatus" },
  { flag: "urgent", on: "緊急", off: "緊急", can: "urgent" },
  { flag: "bookmarked", on: "ブックマーク", off: "ブックマーク", can: "bookmark" },
];

function StateControls({ study, screen, onChanged }: { study: StudyView; screen: ScreenInfo; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const buttons = STATE_BUTTONS.filter((b) => screen.can[b.can] && typeof study[b.flag] === "boolean");
  if (buttons.length === 0) return null;

  async function toggle(flag: StateFlag, value: boolean) {
    setBusy(true);
    setError(null);
    const result = await postJson(
      `/api/studies/${encodeURIComponent(study.studyInstanceUid ?? "")}/state`,
      { flag, value, version: study.stateVersion ?? 0 },
      screen.csrfToken,
    );
    setBusy(false);
    if (result.status === 409) {
      // ほかの利用者が先に変えた：読み直して、いまの値を見せる（上書きしない）
      setError("ほかの利用者が先に変えたので、読み直した。値を確かめてから、もう一度押す");
      onChanged();
    } else if (!result.ok) setError(errorText(result));
    else onChanged();
  }

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="状態">
      {buttons.map((b) => {
        const on = study[b.flag] === true;
        // 検像・読影は「いまの状態」を出し、押すと切り替える。緊急・ブックマークは印の有無
        const text = b.flag === "inspected" || b.flag === "read" ? (on ? b.on : b.off) : b.on;
        return (
          <Button
            key={b.flag}
            type="button"
            size="sm"
            variant={on ? "default" : "outline"}
            aria-pressed={on}
            disabled={busy}
            data-testid={`state-${b.flag}`}
            onClick={() => void toggle(b.flag, !on)}
          >
            {b.flag === "bookmarked" && <Bookmark aria-hidden />}
            {text}
          </Button>
        );
      })}
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

function AllValues({ uid }: { uid: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["study-values", uid],
    queryFn: () => getJson<{ values: DicomValueRow[] }>(`/api/studies/${encodeURIComponent(uid)}/values`),
    enabled: open,
  });
  return (
    <div className={open ? "w-full" : undefined}>
      <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        すべての DICOM の値
      </Button>
      {open && (
        <div className="mt-2 max-h-80 overflow-auto rounded border border-border" data-testid="all-values">
          {query.isPending && <p className="p-2 text-label">読んでいる</p>}
          {query.isError && (
            <p role="alert" className="p-2 text-danger">
              {query.error.message}
            </p>
          )}
          {query.data && (
            <table className="w-full text-xs">
              <tbody>
                {query.data.values.map((row) => (
                  <tr key={row.tag} className="border-b border-border align-top last:border-0">
                    <td className="px-2 py-1 font-mono whitespace-nowrap text-label">{row.tag}</td>
                    <td className="px-2 py-1 font-mono text-label">{row.vr}</td>
                    <td className="px-2 py-1 break-all">{row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

const STATE_KEYS = ["inspected", "read", "urgent", "bookmarked", "rememberedViewer", "defaultViewer", "stateVersion"] as const;

/** 一覧の行の、状態の項目のうち、値があるものだけ */
function definedStateOf(row: StudyView): Partial<StudyView> {
  const out: Record<string, unknown> = {};
  for (const k of STATE_KEYS) if (row[k] !== undefined) out[k] = row[k];
  return out as Partial<StudyView>;
}

export function StudyDetailPanel({
  row,
  screen,
  onChanged,
  fetchEnabled = true,
}: {
  /** 一覧の行の値（すぐ描く） */
  row: StudyView;
  screen: ScreenInfo;
  onChanged: () => void;
  /** false の間は詳細を取らない（矢印のキーで通り過ぎる行の「詳細を開いた」記録を量産しないため。一覧の行の値だけで描く） */
  fetchEnabled?: boolean;
}) {
  const uid = row.studyInstanceUid ?? "";
  // 詳細の取得が「詳細を開いた」の監査の記録（view_study）になる。だから、
  // ・取っていない間（fetchEnabled=false）は、キャッシュに中身があっても出さない
  // ・取った詳細は、行を離れたらキャッシュに残さない（gcTime: 0）。A→B→A と戻っても、出す前に必ず取り直して記録が残る
  const detail = useQuery({
    queryKey: detailKey(uid),
    queryFn: () => fetchDetail(uid),
    enabled: uid !== "" && fetchEnabled,
    gcTime: 0,
    // 取る許しが出るたびに必ず取り直す。gcTime: 0 でも、行を離れてすぐ戻ると（破棄の前に）キャッシュが残ることがあるため
    staleTime: 0,
  });
  // 取り直している間は、前に取った中身（残っていても）を出さない。出すのは、このときの取得が終わってから
  const data = fetchEnabled && !detail.isFetching ? detail.data : undefined;
  const failed = fetchEnabled && detail.isError;
  // 詳細が届くまでは一覧の行の値で描き、届いたら詳細の値にする。
  // 状態の値（検像・読影・緊急・ブックマーク・覚えたビューア）は、状態を変えたあと読み直す一覧の行の値を優先する
  const study: StudyView = { ...row, ...data?.study, ...definedStateOf(row) };
  // 状態を変えたら一覧を読み直す（詳細は取り直さない。取り直すと「詳細を開いた」の記録が二重になる）
  const changed = onChanged;
  const allOpen = useSyncExternalStore(subscribeDetailOpen, getDetailOpen, getServerDetailOpen);
  const allId = useId();

  return (
    <section aria-label="検査の詳細" className="space-y-2 px-3 py-2" data-testid="study-detail" data-study-uid={uid}>
      {/* 見出し：1〜2 行。左に患者と検査の要点、右に状態とビューア */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1 basis-96" data-testid="detail-head">
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span className="font-bold break-words text-value" data-testid="detail-name">
              <span className="sr-only">氏名 </span>
              {study.patientName || <span className="font-normal text-label">（氏名なし）</span>}
            </span>
            {study.patientKana && (
              <span className="text-xs break-words text-label">
                <span className="sr-only">かな </span>
                {study.patientKana}
              </span>
            )}
            <span className="font-mono">
              <span className="sr-only">患者 ID </span>
              {study.patientId}
            </span>
            <span>
              <span className="sr-only">生年月日 </span>
              {formatBirthLine(study.patientBirthDate, study.patientSex, study.studyDate)}
            </span>
          </p>
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span>
              <span className="sr-only">検査日時 </span>
              {`${formatSlashDate(study.studyDate)} ${formatDicomTime(study.studyTime)}`.trim()}
            </span>
            {study.modalities && study.modalities.length > 0 && (
              <span className="font-bold text-value">
                <span className="sr-only">モダリティ </span>
                {study.modalities.join("・")}
              </span>
            )}
            {study.studyDescription && (
              <span className="break-words text-label">
                <span className="sr-only">検査の記述 </span>
                {study.studyDescription}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StateControls study={study} screen={screen} onChanged={changed} />
          <ViewerMenu
            studyUid={uid}
            defaultViewer={study.defaultViewer}
            rememberedViewer={study.rememberedViewer}
            stateVersion={study.stateVersion}
            screen={screen}
            onChanged={changed}
          />
        </div>
      </div>

      {/* シリーズのサムネイルを横に 1 列（横にスクロール。まわりだけ暗い地） */}
      <div data-theme="dark" className="rounded-md bg-background p-2 text-foreground" data-testid="series-strip">
        {!data && !failed && <p className="text-label">読んでいる</p>}
        {failed && (
          <p role="alert" className="text-danger">
            {detail.error?.message}
          </p>
        )}
        {data && data.series.length === 0 && <p className="text-label">シリーズが無い</p>}
        {data && data.series.length > 0 && (
          // 横にスクロールする部品は、キーボードでも動かせるようにフォーカスを受ける（矢印の左右）
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          <ul aria-label="シリーズ" tabIndex={0} className="flex gap-2 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" data-testid="series-row">
            {data.series.map((s) => (
              <li key={s.seriesInstanceUid} className="w-32 shrink-0 space-y-1 rounded border border-border bg-surface p-1.5" data-testid="series-item">
                <Thumbnail studyUid={uid} seriesUid={s.seriesInstanceUid} size={72} />
                <p className="text-xs font-bold break-words text-value">
                  {s.seriesNumber ? `#${s.seriesNumber} ` : ""}
                  {s.seriesDescription || <span className="font-normal text-label">（記述なし）</span>}
                </p>
                <p className="text-xs text-label">
                  {[s.modality, s.bodyPartExamined, s.instanceCount != null ? `${s.instanceCount} 画像` : ""].filter(Boolean).join("・")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={allOpen}
          aria-controls={allId}
          data-testid="detail-all-items-toggle"
          onClick={() => setDetailOpen(!allOpen)}
        >
          {allOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          すべての項目
        </Button>
        {screen.can.allValues && uid && <AllValues uid={uid} />}
      </div>

      {allOpen && (
      <div id={allId} className="space-y-3 pt-1" data-testid="detail-all-items">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-bold text-label">検査の情報</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
            <Item label="検査日時" value={`${formatSlashDate(study.studyDate)} ${formatDicomTime(study.studyTime)}`.trim()} />
            <Item label="モダリティ" value={study.modalities?.join("・")} />
            <Item label="受付番号" value={study.accessionNumber} />
            <Item label="検査の番号（StudyID）" value={study.studyId} />
            <Item label="検査の記述" value={study.studyDescription} wide />
            <Item label="依頼医" value={study.referringPhysicianName} />
            <Item
              label="シリーズ・画像"
              value={study.seriesCount == null && study.instanceCount == null ? "" : `${study.seriesCount ?? "—"} シリーズ・${study.instanceCount ?? "—"} 画像`}
            />
          </dl>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-bold text-label">患者の情報</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
            <Item label="患者 ID" value={study.patientId} />
            <Item label="性別" value={sexLabel(study.patientSex)} />
            <Item label="氏名（漢字）" value={study.patientName} />
            <Item label="氏名（かな）" value={study.patientKana} />
            <Item label="氏名（英字）" value={study.patientNameAlphabetic} />
            <Item label="生年月日" value={formatBirthLine(study.patientBirthDate, undefined, study.studyDate)} />
          </dl>
        </div>
      </div>

      {uid && <UidLine label="StudyInstanceUID" uid={uid} />}
      {data?.series.map(
        (s) =>
          s.seriesInstanceUid && (
            <UidLine key={s.seriesInstanceUid} label={`SeriesInstanceUID${s.seriesNumber ? ` #${s.seriesNumber}` : ""}`} uid={s.seriesInstanceUid} />
          ),
      )}
      </div>
      )}
    </section>
  );
}
