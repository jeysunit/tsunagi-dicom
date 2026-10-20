"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { PendingText, useDelayedPending } from "@/components/ui/pending";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { PacsActions } from "@/components/studies/pacs-actions";
import { Thumbnail } from "@/components/studies/thumbnail";
import { ViewerMenu } from "@/components/studies/viewer-menu";
import type { DicomValueRow } from "@/lib/all-values";
import { getJson } from "@/lib/client/api";
import { getDetailOpen, getServerDetailOpen, setDetailOpen, subscribeDetailOpen } from "@/lib/client/detail-open";
import type { SeriesView, StudyView } from "@/lib/fields";
import { formatAge, formatBirthWareki, formatDicomTime, formatSlashDate, sexLabel } from "@/lib/format/japanese-date";
import { cn } from "@/lib/utils";

// 詳細のパネル（docs/spec.md の 3.1）。一覧の下の場所に出す。行を選ぶと、動きの遅れ無しに替わる（一覧の行の値ですぐ描き、
// シリーズの並びは画面の API から後で足す）。
// 業務で毎回見る値は見出しの 2 行に常に出す（2026-10-20 に「すべての項目」を開け閉めする形から直した。UX のレビューの H8）：
//   1 行目：氏名・カナ・英字氏名・患者ID・生年月日と和暦・年齢・性別
//   2 行目：検査日時・モダリティ・検査名・受付番号・依頼医・Study ID・シリーズ数と画像数
// 値の無い項目は省く。受付番号だけは、無いときも「受付番号 —」を出す（無いこと自体が照合の手がかりになる）。
// その下にシリーズのサムネイルを横に 1 列（横にスクロール。まわりだけ暗い地）。開け閉めは「UID」と「DICOM タグ」の2つだけ
// （UID の開閉はこの端末のブラウザに覚える）。値は `…` で切らずに折り返す。UID は行の幅いっぱいに、小さく等幅で出す。

export interface StudyDetailData {
  study: StudyView;
  series: SeriesView[];
}

export const detailKey = (uid: string) => ["study", uid] as const;
// UID は画像サーバーから来た値なので、path に入れるときは符号化する（BFF の側でも形を確かめる）
export const fetchDetail = (uid: string) => getJson<StudyDetailData>(`/api/studies/${encodeURIComponent(uid)}`);

/**
 * 見出しの1つの項目（小さな項目名と値）。値が無ければ何も出さない（keepEmpty なら「—」を出す。受付番号）。
 * 項目名は読み上げにも見た目にも付ける（「受付番号 ACC-0002-2」）
 */
function HeadItem({
  label,
  value,
  keepEmpty = false,
  testId,
  className,
}: {
  label: string;
  value: string | null | undefined;
  keepEmpty?: boolean;
  testId?: string;
  className?: string;
}) {
  const empty = value === "" || value == null;
  if (empty && !keepEmpty) return null;
  return (
    <span className={cn("break-words", className)} data-testid={testId}>
      <span className="mr-1 text-xs text-label">{label}</span>
      {empty ? <span className="text-label">—</span> : value}
    </span>
  );
}

/** 見出しの、項目名を見せない値（氏名・患者ID など。読み上げにだけ項目名を付ける） */
function HeadValue({ label, value, className, testId }: { label: string; value: string | null | undefined; className?: string; testId?: string }) {
  if (value === "" || value == null) return null;
  return (
    <span className={cn("break-words", className)} data-testid={testId}>
      <span className="sr-only">{label} </span>
      {value}
    </span>
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
      {/* 読み上げにも、コピーできたことを知らせる */}
      <span role="status" className="sr-only">
        {done ? "コピーしました" : ""}
      </span>
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

/**
 * 操作ログに残る読み取り（DICOM タグ）の取り方：出すたびに必ず BFF から読み直し（権限の確かめと操作ログを通す）、
 * 読み直している間と失敗したときは、前に読んだ中身を出さない。行を離れたら残さない（詳細の取り方と同じ）
 */
const AUDITED_READ = { staleTime: 0, gcTime: 0 } as const;

/** DICOM タグの表（タグ・VR・値）。url の画面の API から読む（読んだことは BFF が操作ログに残す） */
function ValuesBox({ url, queryKey, testId }: { url: string; queryKey: readonly unknown[]; testId: string }) {
  const query = useQuery({ queryKey, queryFn: () => getJson<{ values: DicomValueRow[] }>(url), ...AUDITED_READ });
  const data = query.isFetching || query.isError ? undefined : query.data;
  return (
    <div className="max-h-80 overflow-auto rounded border border-border bg-background" data-testid={testId}>
      {query.isFetching && (
        <p className="p-2">
          <PendingText pending />
        </p>
      )}
      {query.isError && !query.isFetching && (
        <p role="alert" className="p-2 text-danger">
          {query.error.message}
        </p>
      )}
      {data && (
        <table className="w-full text-xs">
          <tbody>
            {data.values.map((row) => (
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
  );
}

interface InstanceItem {
  sopInstanceUid: string;
  sopClassUid: string;
  instanceNumber: string;
  numberOfFrames: number | null;
}

/** シリーズの選択肢の文字（許可の一覧に無い項目は省く。何も無ければ UID） */
function seriesLabel(s: SeriesView): string {
  const head = [s.seriesNumber ? `#${s.seriesNumber}` : "", s.seriesDescription ?? ""].filter(Boolean).join(" ");
  const tail = [s.modality, s.instanceCount != null ? `${s.instanceCount} 画像` : ""].filter(Boolean).join("・");
  const text = [head, tail ? `（${tail}）` : ""].join("");
  return text || (s.seriesInstanceUid ?? "");
}

/** 画像の選択肢の文字（画像の番号。複数フレームの画像はフレームの数も） */
function instanceLabel(i: InstanceItem): string {
  const frames = i.numberOfFrames != null && i.numberOfFrames > 1 ? `（${i.numberOfFrames} フレーム）` : "";
  return `${i.instanceNumber ? `#${i.instanceNumber}` : i.sopInstanceUid}${frames}`;
}

const SELECT = "h-7 max-w-full rounded-md border border-border bg-background px-2 text-sm text-value";

/** 画像単位の DICOM タグ：シリーズ → 画像を選び、その画像の SOPInstanceUID と値の全部を出す（最初はシリーズと画像の先頭） */
function InstanceTags({ uid, series }: { uid: string; series: SeriesView[] | undefined }) {
  const list = (series ?? []).filter((s) => !!s.seriesInstanceUid);
  const [seriesPick, setSeriesPick] = useState("");
  const [sopPick, setSopPick] = useState("");
  const seriesUid = list.some((s) => s.seriesInstanceUid === seriesPick) ? seriesPick : (list[0]?.seriesInstanceUid ?? "");
  const instances = useQuery({
    queryKey: ["instances", uid, seriesUid],
    queryFn: () =>
      getJson<{ instances: InstanceItem[] }>(`/api/studies/${encodeURIComponent(uid)}/series/${encodeURIComponent(seriesUid)}/instances`),
    enabled: seriesUid !== "",
    ...AUDITED_READ,
  });
  const items = (instances.isFetching || instances.isError ? undefined : instances.data?.instances) ?? [];
  const sop = items.some((i) => i.sopInstanceUid === sopPick) ? sopPick : (items[0]?.sopInstanceUid ?? "");
  if (!series) return <PendingText pending />;
  if (list.length === 0) return <p className="text-label">シリーズがありません</p>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-xs text-label">シリーズ</span>
          <select
            className={SELECT}
            value={seriesUid}
            onChange={(e) => {
              setSeriesPick(e.target.value);
              setSopPick("");
            }}
            data-testid="tags-series"
          >
            {list.map((s) => (
              <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>
                {seriesLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-xs text-label">画像</span>
          <select className={SELECT} value={sop} disabled={items.length === 0} onChange={(e) => setSopPick(e.target.value)} data-testid="tags-instance">
            {items.map((i) => (
              <option key={i.sopInstanceUid} value={i.sopInstanceUid}>
                {instanceLabel(i)}
              </option>
            ))}
          </select>
        </label>
        <PendingText pending={instances.isFetching} />
      </div>
      {instances.isError && !instances.isFetching && (
        <p role="alert" className="text-danger">
          {instances.error.message}
        </p>
      )}
      {!instances.isFetching && instances.data?.instances.length === 0 && <p className="text-label">画像がありません</p>}
      {sop && (
        <>
          <UidLine label="SOPInstanceUID" uid={sop} />
          <ValuesBox
            key={sop}
            url={`/api/studies/${encodeURIComponent(uid)}/series/${encodeURIComponent(seriesUid)}/instances/${encodeURIComponent(sop)}/values`}
            queryKey={["instance-values", uid, seriesUid, sop]}
            testId="instance-values"
          />
        </>
      )}
    </div>
  );
}

/**
 * 開け閉めの「DICOM タグ」の中身（docs/spec.md の 3.1）。検査単位（QIDO-RS の検査の検索の1行の要約。どの画像の値かは分からない）と、
 * 画像単位（選んだ1枚の画像の値の全部）を切り替える。既定は検査単位
 */
function DicomTags({ uid, series, id }: { uid: string; series: SeriesView[] | undefined; id: string }) {
  const [level, setLevel] = useState<"study" | "instance">("study");
  const tab = (value: "study" | "instance", label: string) => (
    <button
      type="button"
      aria-pressed={level === value}
      onClick={() => setLevel(value)}
      data-testid={`tags-level-${value}`}
      className={cn(
        "inline-flex h-7 items-center border-r border-border px-2 text-sm last:border-r-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
        level === value ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-hover active:bg-pressed",
      )}
    >
      {label}
    </button>
  );
  return (
    <div id={id} className="space-y-2 pt-1" data-testid="dicom-tags">
      <div className="inline-flex overflow-hidden rounded-md border border-border" role="group" aria-label="DICOM タグの単位">
        {tab("study", "検査単位（要約）")}
        {tab("instance", "画像単位")}
      </div>
      {level === "study" ? (
        <ValuesBox url={`/api/studies/${encodeURIComponent(uid)}/values`} queryKey={["study-values", uid]} testId="all-values" />
      ) : (
        <InstanceTags uid={uid} series={series} />
      )}
    </div>
  );
}

/** シリーズの並びの読み込みの間の骨組み（灰色の箱を3つ。0.3 秒たってから出す。docs/spec.md の 2.3） */
function SeriesSkeleton({ pending }: { pending: boolean }) {
  const shown = useDelayedPending(pending);
  if (!shown) return <div className="h-32" aria-hidden />;
  return (
    <div className="flex gap-2" aria-busy="true" data-testid="series-skeleton">
      <span className="sr-only" role="status">
        読み込み中
      </span>
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden className="h-32 w-32 shrink-0 animate-pulse rounded border border-border bg-surface" />
      ))}
    </div>
  );
}

const VIEWER_KEYS = ["rememberedViewer", "defaultViewer", "viewerVersion"] as const;

/** 一覧の行の、ビューアの覚えの項目のうち、値があるものだけ */
function definedViewerOf(row: StudyView): Partial<StudyView> {
  const out: Record<string, unknown> = {};
  for (const k of VIEWER_KEYS) if (row[k] !== undefined) out[k] = row[k];
  return out as Partial<StudyView>;
}

export function StudyDetailPanel({
  row,
  screen,
  onChanged,
  onDeleted,
  fetchEnabled = true,
}: {
  /** 一覧の行の値（すぐ描く） */
  row: StudyView;
  screen: ScreenInfo;
  onChanged: () => void;
  /** 削除が終わったとき（一覧の上に知らせを出し、一覧を読み直す） */
  onDeleted?: (study: StudyView) => void;
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
  // 覚えたビューアの値は、覚えを変えたあと読み直す一覧の行の値を優先する
  const study: StudyView = { ...row, ...data?.study, ...definedViewerOf(row) };
  // 覚えを変えたら一覧を読み直す（詳細は取り直さない。取り直すと「詳細を開いた」の記録が二重になる）
  const changed = onChanged;
  const allOpen = useSyncExternalStore(subscribeDetailOpen, getDetailOpen, getServerDetailOpen);
  const allId = useId();
  // 「DICOM タグ」（権限のある役割だけ。既定は閉じる。行が替わると閉じる）
  const tagsShown = screen.can.allValues && uid !== "";
  const [tagsOpen, setTagsOpen] = useState(false);
  const tagsId = useId();

  return (
    <section aria-label="検査の詳細" className="space-y-2 px-3 py-2" data-testid="study-detail" data-study-uid={uid}>
      {/* 見出し：1〜2 行。左に患者と検査の要点、右にビューア */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        {/* 左の縦線は、一覧で選んだ行の縦線と同じ（どの行の詳細かを示す。docs/spec.md の 3.1） */}
        <div className="min-w-0 flex-1 basis-96 border-l-[3px] border-primary pl-2" data-testid="detail-head">
          {/* 1 行目：患者（本人の確かめの手がかり） */}
          <p className="flex flex-wrap items-baseline gap-x-3" data-testid="detail-head-patient">
            <span className="font-bold break-words text-value" data-testid="detail-name">
              <span className="sr-only">氏名 </span>
              {study.patientName || <span className="font-normal text-label">（氏名未登録）</span>}
            </span>
            <HeadValue label="カナ" value={study.patientKana} className="text-xs text-label" />
            <HeadValue label="英字氏名" value={study.patientNameAlphabetic} className="text-xs text-label" testId="detail-alphabetic" />
            <HeadValue label="患者ID" value={study.patientId} className="font-mono" />
            <HeadValue label="生年月日" value={formatBirthWareki(study.patientBirthDate)} />
            <HeadValue label="年齢" value={formatAge(study.patientBirthDate, study.studyDate)} />
            <HeadValue label="性別" value={sexLabel(study.patientSex)} />
          </p>
          {/* 2 行目：検査（毎回見る値。前は「すべての項目」の中にあった受付番号・依頼医・Study ID・シリーズ数と画像数もここ） */}
          <p className="flex flex-wrap items-baseline gap-x-3" data-testid="detail-head-study">
            <HeadValue label="検査日時" value={`${formatSlashDate(study.studyDate)} ${formatDicomTime(study.studyTime)}`.trim()} />
            <HeadValue label="モダリティ" value={study.modalities?.join("・")} className="font-bold text-value" />
            <HeadValue label="検査名" value={study.studyDescription} className="text-label" />
            {/* 受付番号は、値が空でも「受付番号 —」を出す。役割の許可の一覧に無い（項目ごと返らない）ときは出さない（空と見分ける） */}
            <HeadItem label="受付番号" value={study.accessionNumber} keepEmpty={Object.hasOwn(study, "accessionNumber")} testId="detail-accession" />
            <HeadItem label="依頼医" value={study.referringPhysicianName} testId="detail-referring" />
            <HeadItem label="Study ID" value={study.studyId} />
            <HeadItem
              label="Se/Im"
              value={study.seriesCount == null && study.instanceCount == null ? "" : `${study.seriesCount ?? "—"} / ${study.instanceCount ?? "—"}`}
              testId="detail-counts"
            />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewerMenu
            studyUid={uid}
            defaultViewer={study.defaultViewer}
            rememberedViewer={study.rememberedViewer}
            viewerVersion={study.viewerVersion}
            screen={screen}
            onChanged={changed}
          />
        </div>
      </div>

      {/* PACS の操作（送る・書き出し・削除。役割に許されたものだけ）。行が替わったら作り直す */}
      <PacsActions key={uid} study={study} screen={screen} onDeleted={(s) => (onDeleted ? onDeleted(s) : changed())} />

      {/* シリーズのサムネイルを横に 1 列（横にスクロール。まわりだけ暗い地） */}
      <div data-theme="dark" className="rounded-md bg-background p-2 text-foreground" data-testid="series-strip" data-loaded={data ? "true" : "false"}>
        {!data && !failed && <SeriesSkeleton pending={fetchEnabled} />}
        {failed && (
          <p role="alert" className="text-danger">
            {detail.error?.message}
          </p>
        )}
        {data && data.series.length === 0 && <p className="text-label">シリーズがありません</p>}
        {data && data.series.length > 0 && (
          // 横にスクロールする部品は、キーボードでも動かせるようにフォーカスを受ける（矢印の左右）
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          <ul aria-label="シリーズ" tabIndex={0} className="flex gap-2 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" data-testid="series-row">
            {data.series.map((s) => (
              <li key={s.seriesInstanceUid} className="w-32 shrink-0 space-y-1 rounded border border-border bg-surface p-1.5" data-testid="series-item">
                <Thumbnail studyUid={uid} seriesUid={s.seriesInstanceUid} size={72} />
                <p className="text-xs font-bold break-words text-value">
                  {s.seriesNumber ? `#${s.seriesNumber} ` : ""}
                  {s.seriesDescription || <span className="font-normal text-label">（シリーズ名なし）</span>}
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
          data-testid="detail-uid-toggle"
          onClick={() => setDetailOpen(!allOpen)}
        >
          {allOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          UID
        </Button>
        {/* 開いても、ボタンの位置は動かさない（中身はボタンの並びの下に出す。2026-10-21。前は開くと入れ物が横いっぱいになり、ボタンが次の行へ移った） */}
        {tagsShown && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={tagsOpen}
            aria-controls={tagsId}
            data-testid="detail-tags-toggle"
            onClick={() => setTagsOpen((v) => !v)}
          >
            {tagsOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            DICOM タグ
          </Button>
        )}
      </div>

      {/* 開け閉めの「UID」の中は、StudyInstanceUID と SeriesInstanceUID だけ（ほかの値は見出しに上げた） */}
      {allOpen && (
      <div id={allId} className="space-y-1 pt-1" data-testid="detail-uid">
      {uid && <UidLine label="StudyInstanceUID" uid={uid} />}
      {data?.series.map(
        (s) =>
          s.seriesInstanceUid && (
            <UidLine key={s.seriesInstanceUid} label={`SeriesInstanceUID${s.seriesNumber ? ` #${s.seriesNumber}` : ""}`} uid={s.seriesInstanceUid} />
          ),
      )}
      </div>
      )}
      {tagsShown && tagsOpen && <DicomTags uid={uid} series={data?.series} id={tagsId} />}
    </section>
  );
}
