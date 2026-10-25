"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Button, pressFeedback, pressInset } from "@/components/ui/button";
import { PatientBanner, type PatientBannerItem } from "@/components/ui/patient-banner";
import { PendingText, useDelayedPending } from "@/components/ui/pending";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { PacsActions } from "@/components/studies/pacs-actions";
import { TagGrid } from "@/components/studies/tag-grid";
import { Thumbnail } from "@/components/studies/thumbnail";
import { ViewerMenu } from "@/components/studies/viewer-menu";
import type { DicomValueRow } from "@/lib/all-values";
import { getJson } from "@/lib/client/api";
import type { SeriesView, StudyView } from "@/lib/fields";
import { formatAge, formatBirthWareki, formatDicomTime, formatSlashDate, sexLabel } from "@/lib/format/japanese-date";
import { tagName } from "@/lib/instance-tags";
import { cn } from "@/lib/utils";

// 詳細のパネル（docs/spec.md の 3.1）。一覧の下の場所に出す。行を選ぶと、動きの遅れ無しに替わる（一覧の行の値ですぐ描き、
// シリーズの並びは画面の API から後で足す）。
// 見出しは、3 製品で共通の患者バナー（docs/design-system/components.md。2026-10-25 に、氏名などを数行に並べる形から替えた）。
// バナーの並び：氏名（かな）・患者ID・生年月日と年齢・性別・受付番号・検査日時・モダリティと検査名。
// 値の無い項目は省く。受付番号だけは、無いときも「受付番号 —」を出す（無いこと自体が照合の手がかりになる）。
// 英字氏名・和暦・紹介医・Study ID・シリーズ数と画像数は、バナーに足さず、UID の行の下の「検査の情報」に項目名と値の対で並べる
// （タブに隠さない。前のタブは中身が数行で空白が大きかった）。
// その下に、シリーズのサムネイルを横に 1 列（横にスクロール。まわりだけ暗い地）。DICOM の値を見る権限のある役割では、
// サムネイルを押すと、その下にシリーズの画像の場所（画像の一覧と、画像ごとのタグ）を開く。もう一度押すと閉じる。
// UID は開け閉めせず、バナーの下に StudyInstanceUID、画像の場所の見出しに SeriesInstanceUID を、写すボタンつきで出す
// （2026-10-24。前は下に「UID」と「DICOM タグ」のボタンがあり、画像の場所と役割が重なっていた。#57）。検査単位のタグ（要約）は、
// 画像に関わらないので、Study UID の横の「検査のタグ」のボタンで、見出しの下に開け閉めする。値は `…` で切らずに折り返す。UID は行の幅いっぱいに、小さく等幅で出す。

export interface StudyDetailData {
  study: StudyView;
  series: SeriesView[];
}

export const detailKey = (uid: string) => ["study", uid] as const;
// UID は画像サーバーから来た値なので、path に入れるときは符号化する（BFF の側でも形を確かめる）
export const fetchDetail = (uid: string) => getJson<StudyDetailData>(`/api/studies/${encodeURIComponent(uid)}`);

/** 「検査の情報」の 1 行（項目名と値）。値が無い項目は渡さない */
interface InfoRow {
  label: string;
  value: string;
  testId?: string;
  mono?: boolean;
}

/**
 * 「検査の情報」：バナーに足さない、毎回は見ない値（英字氏名・和暦・紹介医・Study ID・シリーズ数と画像数）。
 * タブに隠さず、詳細の上部（バナーと UID の下）に、項目名と値の対を折り返して並べる（空白の多いタブをやめた）
 */
function StudyInfo({ rows }: { rows: readonly InfoRow[] }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1" data-testid="detail-info">
      {rows.map((r) => (
        <div key={r.label} className="flex min-w-0 items-baseline gap-2" data-testid={r.testId}>
          <dt className="shrink-0 text-xs text-label">{r.label}</dt>
          <dd className={cn("min-w-0 break-words text-value", r.mono && "font-mono")}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 写せたことを示す時間（ms）。値の地を光らせ、「コピーしました」を出す */
const COPIED_MS = 1500;

/**
 * StudyInstanceUID・SeriesInstanceUID・SOPInstanceUID：0.75rem・等幅・控えめの色で折り返して出し、写すボタンを値のすぐ右に置く。
 * 値そのものを押しても写せる（文字をドラッグで選んだときは写さない）。写したら、値の地を一瞬 selected にして「コピーしました」を出す
 */
function UidLine({ label, uid, testId = "uid-line" }: { label: string; uid: string; testId?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [done]);
  function copy() {
    void navigator.clipboard.writeText(uid).then(
      () => setDone(true),
      () => undefined,
    );
  }
  return (
    <div className="flex items-baseline gap-2" data-testid={testId}>
      <span className="shrink-0 text-xs text-label">{label}</span>
      {/* 写すボタンは値のすぐ右（行の右端に離さない）。長い UID が折り返すときは、最後の行の末尾に付く */}
      <span className="min-w-0">
        {/* 値を押して写すのはマウスの近道（キーボードは隣のボタン）なので、読み上げには出さない */}
        <code
          role="presentation"
          className={cn("cursor-copy rounded-sm font-mono text-[0.75rem] break-all text-label", done && "bg-selected")}
          data-copied={done || undefined}
          onClick={() => {
            if (window.getSelection()?.isCollapsed === false) return;
            copy();
          }}
        >
          {uid}
        </code>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-1 h-6 align-middle"
          aria-label={`${label}をコピー`}
          onClick={copy}
        >
          {done ? <Check aria-hidden /> : <Copy aria-hidden />}
        </Button>
        {/* 見える知らせと、読み上げへの知らせ（常に置き、中身だけ替える） */}
        <span role="status" className="ml-1 text-xs text-label" data-testid="uid-copied">
          {done ? "コピーしました" : ""}
        </span>
      </span>
    </div>
  );
}

/**
 * 操作ログに残る読み取り（DICOM タグ）の取り方：出すたびに必ず BFF から読み直し（権限の確かめと操作ログを通す）、
 * 読み直している間と失敗したときは、前に読んだ中身を出さない。行を離れたら残さない（詳細の取り方と同じ）
 */
const AUDITED_READ = { staleTime: 0, gcTime: 0 } as const;

/** 表の1行（タグ・タグ名・VR・値）。値が無いタグは value が null（「—」を出す）。length は切った値の全体の文字数 */
interface TagRow {
  tag: string;
  name?: string;
  vr: string;
  value: string | null;
  length?: number;
}

/**
 * DICOM タグの表（タグ・タグ名・VR・値）。url の画面の API から読み（読んだことは BFF が操作ログに残す）、pick で行にする。
 * 列の幅は決めておき（table-fixed）、表を替えても列の境目を動かさない。値は文字として出す（HTML として解かない）
 */
function TagTable<T>({
  url,
  queryKey,
  pick,
  testId,
  className,
}: {
  url: string;
  queryKey: readonly unknown[];
  pick: (body: T) => TagRow[];
  testId: string;
  className?: string;
}) {
  const query = useQuery({ queryKey, queryFn: () => getJson<T>(url), ...AUDITED_READ });
  const rows = query.isFetching || query.isError || !query.data ? undefined : pick(query.data);
  return (
    <div className={cn("max-h-80 overflow-auto rounded border border-border bg-background", className)} data-testid={testId}>
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
      {rows && <TagGrid rows={rows} />}
    </div>
  );
}

/** 値の全部の行に、タグ名を添える（表に無いタグは空） */
const valueRows = (body: { values: DicomValueRow[] }): TagRow[] => body.values.map((row) => ({ ...row, name: tagName(row.tag) }));

interface InstanceItem {
  sopInstanceUid: string;
  sopClassUid: string;
  instanceNumber: string;
  numberOfFrames: number | null;
  /** スライス位置（mm）。画像サーバーが返したときだけ数、それ以外は null */
  sliceLocation: number | null;
}

/** 画像の一覧の 1 行の文字（画像の番号。無ければ SOPInstanceUID。スライス位置があれば「12.5 mm」。複数フレームの画像はフレームの数も） */
function instanceLabel(i: InstanceItem): string {
  const frames = i.numberOfFrames != null && i.numberOfFrames > 1 ? `（${i.numberOfFrames} フレーム）` : "";
  // 小数 2 位までに丸める（DS の「-55.0000」のような桁を並べない）
  const slice = i.sliceLocation != null && Number.isFinite(i.sliceLocation) ? ` ${Math.round(i.sliceLocation * 100) / 100} mm` : "";
  return `${i.instanceNumber ? `#${i.instanceNumber}` : i.sopInstanceUid}${slice}${frames}`;
}

/** 画像の場所のタグの組：主なタグ（設定の INSTANCE_TAGS）・すべてのタグ（その画像の値の全部）。検査のタグ（検査単位の要約）は、画像に関わらないので、Study UID の横から開く */
type TagSet = "configured" | "all";

/** 切り替えの1つ（押した形を aria-pressed と地の色で示す） */
function SegmentButton({ pressed, onClick, testId, children }: { pressed: boolean; onClick: () => void; testId: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "inline-flex h-7 items-center border-r border-border px-2 text-sm last:border-r-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
        pressInset,
        pressed ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-hover active:bg-pressed",
      )}
    >
      {children}
    </button>
  );
}

/**
 * シリーズの画像の場所（docs/spec.md の 3.1）。サムネイルを押すと、サムネイルの並びの下に開く。
 * 左に画像の一覧（画像の番号の順。上下の矢印のキーで替える。Home・End で先頭・末尾）、右に選んだ画像の SOPInstanceUID とタグの表。
 * 表は「主なタグ」（設定のタグだけ。タグ名つき）と「すべてのタグ」（値の全部）を切り替える。最初は先頭の画像を選ぶ
 */
function SeriesImages({
  uid,
  series,
  tagSet,
  onTagSet,
  sopPick,
  setSopPick,
  panelId,
}: {
  uid: string;
  series: SeriesView;
  tagSet: TagSet;
  onTagSet: (set: TagSet) => void;
  /** 選んだ画像の SOPInstanceUID（まだ選んでいなければ空）。詳細の取り直しで画像の場所を作り直しても戻れるよう、持ち主は親 */
  sopPick: string;
  setSopPick: (sop: string) => void;
  /** サムネイルの aria-controls が指す id */
  panelId: string;
}) {
  const seriesUid = series.seriesInstanceUid ?? "";
  const listId = useId();
  const instances = useQuery({
    queryKey: ["instances", uid, seriesUid],
    queryFn: () =>
      getJson<{ instances: InstanceItem[] }>(`/api/studies/${encodeURIComponent(uid)}/series/${encodeURIComponent(seriesUid)}/instances`),
    ...AUDITED_READ,
  });
  const items = (instances.isFetching || instances.isError ? undefined : instances.data?.instances) ?? [];
  const index = Math.max(
    0,
    items.findIndex((i) => i.sopInstanceUid === sopPick),
  );
  const sop = items[index]?.sopInstanceUid ?? "";
  // 値を読む画像。矢印のキーで通り過ぎる画像の値は読まない（読むたびに操作ログに残るため）。キーで選んだ画像は 0.3 秒止まってから読み、
  // クリックで選んだ画像はすぐ読む（一覧の行の詳細の取り方と同じ考え）
  const [settledPick, setSettledPick] = useState(sopPick);
  useEffect(() => {
    if (sopPick === settledPick) return;
    const timer = window.setTimeout(() => setSettledPick(sopPick), 300);
    return () => window.clearTimeout(timer);
  }, [sopPick, settledPick]);
  const readSop = sopPick === settledPick ? sop : "";
  const choose = (next: string) => {
    setSopPick(next);
    setSettledPick(next);
  };
  const optionId = (i: number) => `${listId}-${i}`;
  const base = `/api/studies/${encodeURIComponent(uid)}/series/${encodeURIComponent(seriesUid)}/instances/${encodeURIComponent(readSop)}`;
  const title = [series.seriesNumber ? `#${series.seriesNumber}` : "", series.seriesDescription ?? ""].filter(Boolean).join(" ");

  return (
    <section aria-label="画像" id={panelId} className="space-y-2 rounded-md border border-border p-2" data-testid="series-images" data-series-uid={seriesUid}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-bold break-words text-value">{title || <span className="font-normal text-label">（シリーズ名なし）</span>}</h3>
        {series.instanceCount != null && <span className="text-xs text-label">{series.instanceCount} 画像</span>}
        <PendingText pending={instances.isFetching} />
        {/* 切り替えは、画像の一覧の読み込みが終わってから。画像に関するタグだけ（検査のタグは、Study UID の横のボタンから） */}
        {items.length > 0 && (
          <div className="ml-auto inline-flex overflow-hidden rounded-md border border-border-input" role="group" aria-label="タグの表示">
            <SegmentButton pressed={tagSet === "configured"} onClick={() => onTagSet("configured")} testId="tag-set-configured">
              主なタグ
            </SegmentButton>
            <SegmentButton pressed={tagSet === "all"} onClick={() => onTagSet("all")} testId="tag-set-all">
              すべてのタグ
            </SegmentButton>
          </div>
        )}
      </div>
      {seriesUid && <UidLine label="SeriesInstanceUID" uid={seriesUid} testId="series-uid" />}
      {instances.isError && !instances.isFetching && (
        <p role="alert" className="text-danger">
          {instances.error.message}
        </p>
      )}
      {!instances.isFetching && instances.data?.instances.length === 0 && <p className="text-label">画像がありません</p>}
      {items.length > 0 && (
        <div className="grid gap-2 md:grid-cols-[10rem_minmax(0,1fr)]">
          {/* 画像の一覧。フォーカスは一覧に置き、上下の矢印のキーで選ぶ画像を替える（選んだ行は aria-activedescendant） */}
          <ul
            role="listbox"
            aria-label="画像の一覧"
            tabIndex={0}
            aria-activedescendant={optionId(index)}
            className="max-h-40 overflow-auto rounded border border-border bg-background py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring md:max-h-80"
            data-testid="instance-list"
            onKeyDown={(e) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
              e.preventDefault();
              e.stopPropagation();
              const step = e.key === "ArrowDown" ? index + 1 : index - 1;
              const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : Math.min(items.length - 1, Math.max(0, step));
              setSopPick(items[next]!.sopInstanceUid);
              document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
            }}
          >
            {items.map((item, i) => (
              // 選ぶのは一覧（listbox）のキーと、行のクリック。行はフォーカスを受けない（aria-activedescendant で示す）
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events
              <li
                key={item.sopInstanceUid}
                id={optionId(i)}
                role="option"
                aria-selected={i === index}
                onClick={() => choose(item.sopInstanceUid)}
                className={cn(
                  "cursor-pointer border-l-[3px] px-2 py-0.5 break-all",
                  i === index ? "border-ring bg-selected font-bold text-value" : "border-transparent hover:bg-hover",
                )}
                data-testid="instance-item"
              >
                {instanceLabel(item)}
              </li>
            ))}
          </ul>
          <div className="min-w-0 space-y-1">
            <UidLine label="SOPInstanceUID" uid={sop} />
            {readSop === "" ? (
              <p className="p-2">
                <PendingText pending />
              </p>
            ) : tagSet === "configured" ? (
              <TagTable<{ tags: TagRow[] }>
                key={`configured-${readSop}`}
                url={`${base}/tags`}
                queryKey={["instance-tags", uid, seriesUid, readSop]}
                pick={(body) => body.tags}
                testId="instance-tags"
              />
            ) : (
              <TagTable<{ values: DicomValueRow[] }>
                key={`all-${readSop}`}
                url={`${base}/values`}
                queryKey={["instance-values", uid, seriesUid, readSop]}
                pick={valueRows}
                testId="instance-values"
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 「検査のタグ」の中身（docs/spec.md の 3.1）。検査単位の要約（QIDO-RS の検査の検索の1行。どの画像の値かは分からない）。
 * Study UID の横の「検査のタグ」から開く。画像ごとの値は、画像の場所の「主なタグ」「すべてのタグ」で見る
 */
function StudyTags({ uid, panelId }: { uid: string; panelId: string }) {
  return (
    <div id={panelId} className="space-y-1" data-testid="dicom-tags">
      <p className="text-xs text-label">検査単位（要約）</p>
      <TagTable<{ values: DicomValueRow[] }>
        url={`/api/studies/${encodeURIComponent(uid)}/values`}
        queryKey={["study-values", uid]}
        pick={valueRows}
        testId="all-values"
      />
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
  // 画像の場所・タグ（権限のある役割だけ）
  const tagsShown = screen.can.allValues && uid !== "";
  // サムネイルから開いた画像の場所（SeriesInstanceUID。同じ権限の役割だけ。行が替わると閉じる）と、主なタグ・すべてのタグの切り替え
  // （切り替えは、画像やシリーズを替えても保つ）
  const [openSeries, setOpenSeries] = useState<string | null>(null);
  const [tagSet, setTagSet] = useState<TagSet>("configured");
  // シリーズごとに選んだ画像。詳細を取り直す間（通信が戻ったときなど）は画像の場所が作り直されるので、ここに覚えて先頭へ戻らないようにする
  const [sopPicks, setSopPicks] = useState<Record<string, string>>({});
  // 「検査のタグ」（検査単位の要約）。Study UID の横のボタンで開け閉めする（行が替わると閉じる）
  const [studyTagsOpen, setStudyTagsOpen] = useState(false);
  const studyTagsId = useId();
  const seriesImagesId = useId();
  const openedSeries = data?.series.find((s) => s.seriesInstanceUid === openSeries);

  // 患者バナー（氏名・かな・患者ID・生年月日と年齢・性別・受付番号・検査日時・モダリティと検査名）。値の無い項目は PatientBanner が省く
  const birthDate = formatSlashDate(study.patientBirthDate);
  const age = formatAge(study.patientBirthDate, study.studyDate);
  const sex = sexLabel(study.patientSex);
  const modalities = study.modalities?.join("・");
  const bannerItems: PatientBannerItem[] = [
    { label: "患者ID", value: study.patientId, mono: true },
    { label: "生年月日・性別", value: `${birthDate}${age ? `（${age}）` : ""}${sex ? ` ${sex}` : ""}`.trim() },
    // 受付番号は、値が空でも「受付番号 —」を出す。役割の許可の一覧に無い（項目ごと返らない）ときは出さない（空と見分ける）
    {
      label: "受付番号",
      value: Object.hasOwn(study, "accessionNumber") ? study.accessionNumber || "—" : "",
      mono: !!study.accessionNumber,
      testId: "detail-accession",
    },
    { label: "検査日時", value: `${formatSlashDate(study.studyDate)} ${formatDicomTime(study.studyTime)}`.trim() },
    {
      label: "モダリティ・検査名",
      value:
        modalities || study.studyDescription ? (
          <>
            {modalities}
            {study.studyDescription && <span className="ml-1 font-normal">{study.studyDescription}</span>}
          </>
        ) : (
          ""
        ),
    },
  ];
  // 「検査の情報」：バナーに足さない値。値の無い項目は出さない
  const counts = study.seriesCount == null && study.instanceCount == null ? "" : `${study.seriesCount ?? "—"} / ${study.instanceCount ?? "—"}`;
  const infoRows: InfoRow[] = (
    [
      { label: "英字氏名", value: study.patientNameAlphabetic, testId: "detail-alphabetic" },
      { label: "生年月日（和暦）", value: formatBirthWareki(study.patientBirthDate) },
      { label: "紹介医", value: study.referringPhysicianName, testId: "detail-referring" },
      { label: "Study ID", value: study.studyId, mono: true },
      { label: "シリーズ / 画像", value: counts, testId: "detail-counts" },
    ] as { label: string; value: string | null | undefined; testId?: string; mono?: boolean }[]
  ).flatMap((r) => (r.value ? [{ ...r, value: r.value }] : []));

  // シリーズのタブ：サムネイルを横に 1 列（横にスクロール。まわりだけ暗い地）と、開いた画像の場所
  const seriesPanel = (
    <>
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
            {data.series.map((s) => {
              const body = (
                <>
                  <Thumbnail studyUid={uid} seriesUid={s.seriesInstanceUid} size={72} />
                  <p className="text-xs font-bold break-words text-value">
                    {s.seriesNumber ? `#${s.seriesNumber} ` : ""}
                    {s.seriesDescription || <span className="font-normal text-label">（シリーズ名なし）</span>}
                  </p>
                  <p className="text-xs text-label">
                    {[s.modality, s.bodyPartExamined, s.instanceCount != null ? `${s.instanceCount} 画像` : ""].filter(Boolean).join("・")}
                  </p>
                </>
              );
              const pressed = !!s.seriesInstanceUid && s.seriesInstanceUid === openSeries;
              return (
                <li key={s.seriesInstanceUid} className="w-32 shrink-0" data-testid="series-item">
                  {tagsShown && s.seriesInstanceUid ? (
                    // 押すと下に画像の場所を開く。選んだサムネイルは、主の色の枠と aria-expanded で示す
                    <button
                      type="button"
                      aria-expanded={pressed}
                      aria-controls={pressed ? seriesImagesId : undefined}
                      onClick={() => setOpenSeries(pressed ? null : (s.seriesInstanceUid ?? null))}
                      className={cn(
                        "w-full cursor-pointer space-y-1 rounded border bg-surface p-1.5 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        pressFeedback,
                        // 選んだ形は枠と地の色で示す（フォーカスの輪と見分ける）
                        pressed ? "border-ring bg-selected" : "border-border hover:border-label hover:bg-hover",
                      )}
                      data-testid="series-open"
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="space-y-1 rounded border border-border bg-surface p-1.5">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {tagsShown && openedSeries && (
        <SeriesImages
          key={openedSeries.seriesInstanceUid}
          uid={uid}
          series={openedSeries}
          panelId={seriesImagesId}
          tagSet={tagSet}
          onTagSet={setTagSet}
          sopPick={sopPicks[openedSeries.seriesInstanceUid ?? ""] ?? ""}
          setSopPick={(sop) => setSopPicks((picks) => ({ ...picks, [openedSeries.seriesInstanceUid ?? ""]: sop }))}
        />
      )}
    </>
  );

  return (
    <section aria-label="検査の詳細" className="space-y-1.5 px-3 py-2" data-testid="study-detail" data-study-uid={uid}>
      {/* 見出し：患者バナーと検査の UID */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        {/* 左の縦線は、一覧で選んだ行の縦線と同じ（どの行の詳細かを示す。docs/spec.md の 3.1） */}
        <div className="min-w-0 flex-1 basis-96 space-y-0.5 border-l-[3px] border-ring pl-2" data-testid="detail-head">
          <PatientBanner
            name={study.patientName || <span className="font-normal text-label">（氏名未登録）</span>}
            nameTestId="detail-name"
            kana={study.patientKana || undefined}
            items={bannerItems}
          />
          {/* 検査の UID（写すボタンつき）と、その横の「検査のタグ」。前は下の「UID」のボタンの中にあった（#57） */}
          {uid && (
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <UidLine label="StudyInstanceUID" uid={uid} testId="study-uid" />
              </div>
              {tagsShown && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="mt-px shrink-0"
                  aria-expanded={studyTagsOpen}
                  aria-controls={studyTagsOpen ? studyTagsId : undefined}
                  data-testid="study-tags-open"
                  onClick={() => setStudyTagsOpen((v) => !v)}
                >
                  検査のタグ
                </Button>
              )}
            </div>
          )}
          {/* 検査の情報：タブに隠さず、バナーと UID の下に並べる */}
          {infoRows.length > 0 && <StudyInfo rows={infoRows} />}
        </div>
      </div>

      {/* 操作の 1 行：左から、主の「開く」・送信・エクスポート、削除は右端に離す（PACS の操作は役割に許されたものだけ）。行が替わったら作り直す */}
      <PacsActions
        key={uid}
        study={study}
        screen={screen}
        onDeleted={(s) => (onDeleted ? onDeleted(s) : changed())}
        leading={
          <ViewerMenu
            studyUid={uid}
            defaultViewer={study.defaultViewer}
            rememberedViewer={study.rememberedViewer}
            viewerVersion={study.viewerVersion}
            screen={screen}
            onChanged={changed}
          />
        }
      />

      {/* 検査のタグ（検査単位の要約）。権限のある役割が、Study UID の横のボタンで開く */}
      {tagsShown && studyTagsOpen && <StudyTags uid={uid} panelId={studyTagsId} />}

      {seriesPanel}
    </section>
  );
}
