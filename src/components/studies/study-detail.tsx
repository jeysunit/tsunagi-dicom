"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { Thumbnail } from "@/components/studies/thumbnail";
import { ViewerMenu } from "@/components/studies/viewer-menu";
import type { DicomValueRow } from "@/lib/all-values";
import { getJson } from "@/lib/client/api";
import { errorText, postJson } from "@/lib/client/post-json";
import type { SeriesView, StudyView } from "@/lib/fields";
import { formatBirthLine, formatDicomTime, formatSlashDate, sexLabel } from "@/lib/format/japanese-date";
import type { StateFlag } from "@/lib/study-state";
import { cn } from "@/lib/utils";

// 詳細のパネル（docs/spec.md の 3.1）。一覧の下の場所に出す。行を選ぶと、動きの遅れ無しに替わる（一覧の行の値ですぐ描き、
// シリーズの並びは画面の API から後で足す）。左が検査の情報（2列）、右が患者の情報（2列）、下にシリーズごとの
// サムネイルの並び（まわりだけ暗い地）。値は `…` で切らずに折り返す。UID は行の幅いっぱいに、小さく等幅で出す。

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
    <div>
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
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: detailKey(uid), queryFn: () => fetchDetail(uid), enabled: uid !== "" && fetchEnabled });
  // 詳細が届くまでは一覧の行の値で描き、届いたら詳細の値にする（状態の変更は両方を読み直す）
  const study: StudyView = { ...row, ...detail.data?.study };
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: detailKey(uid) });
    onChanged();
  };

  return (
    <section aria-label="検査の詳細" className="space-y-4 px-4 py-4" data-testid="study-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
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

      <div>
        <h3 className="mb-2 text-xs font-bold text-label">シリーズ</h3>
        <div data-theme="dark" className="rounded-md bg-background p-3 text-foreground" data-testid="series-strip">
          {detail.isPending && <p className="text-label">読んでいる</p>}
          {detail.isError && (
            <p role="alert" className="text-danger">
              {detail.error.message}
            </p>
          )}
          {detail.data && detail.data.series.length === 0 && <p className="text-label">シリーズが無い</p>}
          {detail.data && detail.data.series.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {detail.data.series.map((s) => (
                <li key={s.seriesInstanceUid} className="space-y-2 rounded border border-border bg-surface p-2" data-testid="series-item">
                  <div className="flex gap-3">
                    <Thumbnail studyUid={uid} seriesUid={s.seriesInstanceUid} size={72} />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="font-bold break-words text-value">
                        {s.seriesNumber ? `#${s.seriesNumber} ` : ""}
                        {s.seriesDescription || <span className="font-normal text-label">（記述なし）</span>}
                      </p>
                      <p className="text-xs text-label">
                        {[s.modality, s.bodyPartExamined, s.instanceCount != null ? `${s.instanceCount} 画像` : ""].filter(Boolean).join("・")}
                      </p>
                    </div>
                  </div>
                  {s.seriesInstanceUid && <UidLine label="SeriesInstanceUID" uid={s.seriesInstanceUid} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {screen.can.allValues && uid && <AllValues uid={uid} />}
    </section>
  );
}
