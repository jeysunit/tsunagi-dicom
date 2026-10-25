import type * as React from "react";
import { ModalityMark } from "@/components/ui/modality-mark";
import { cn } from "@/lib/utils";

// 患者バナー（docs/design-system/parts.md の「患者バナー（`.fb`）」・components.md の「患者バナー」）。
// 患者のある画面の、見出しの下の同じ位置に同じ並びで置く。項目と大きさは中身で変えない。形は 2 つだけ：
// - r2：幅 900px 未満の区画（一覧の右の詳細）。1 行目 氏名（かな）・患者ID・生年月日と性別、2 行目 札・受付番号・検査日時・モダリティと検査名。各行 40px
// - r1：それ以外のすべて（詳細だけの画面など）。1 行に 氏名・患者ID・生年月日と性別・受付番号・検査日時・モダリティと検査名・右端に札
// 値の無い項目も項目名を残し、値を「—」（label の色）にする（詰めると、検査ごとに項目の位置が替わる）。
// かなとモダリティ・検査名は 1 行で切り、全文を title に出す。氏名・患者ID・受付番号は切らない（収まらないときだけ、その行が高くなる）。
// 和暦・紹介医・英字氏名・Study ID・シリーズ数と画像数は、バナーに足さず「検査の情報」に置く。

/** 値の無い項目の印 */
export const NONE = "—";

export interface PatientBannerProps extends Omit<React.ComponentProps<"section">, "children"> {
  /** 氏名（漢字）。無いときは呼ぶ側が「（氏名未登録）」などを渡す */
  name: React.ReactNode;
  kana?: string;
  patientId?: string;
  /** 生年月日・年齢・性別をつないだ文字（「1970/04/01（56歳） 男」） */
  birthSex?: string;
  accessionNumber?: string;
  /** 検査日時（「2026/10/24 09:12」） */
  studyDateTime?: string;
  modalities?: readonly string[];
  studyDescription?: string;
  /** 状態の札（保管の確認など）。r2 では 2 行目の先頭、r1 では右端 */
  end?: React.ReactNode;
  /** r2：一覧の右の詳細の 2 行の形。r1：それ以外の 1 行の形 */
  layout?: "r1" | "r2";
  nameTestId?: string;
}

/** 項目名と値の升（`.f`）。値が空なら「—」。cut は 1 行で切って title に全文、それ以外は切らずに折り返す */
function Field({
  label,
  value,
  title,
  mono = false,
  cut = false,
  className,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  title?: string;
  mono?: boolean;
  cut?: boolean;
  className?: string;
  testId?: string;
}) {
  const empty = value === undefined || value === null || value === "";
  return (
    <dl className={cn("f min-w-0", className)} data-testid={testId}>
      <dt className="l text-xs text-label">{label}</dt>
      <dd
        className={cn(
          "v leading-5",
          empty ? "none text-label" : "font-bold text-value",
          !empty && mono && "font-mono",
          cut ? "overflow-hidden text-ellipsis whitespace-nowrap" : "keep break-all",
        )}
        title={!empty && cut ? title : undefined}
        data-none={empty || undefined}
      >
        {empty ? NONE : value}
      </dd>
    </dl>
  );
}

export function PatientBanner({
  name,
  kana,
  patientId,
  birthSex,
  accessionNumber,
  studyDateTime,
  modalities,
  studyDescription,
  end,
  layout = "r1",
  nameTestId,
  className,
  ...props
}: PatientBannerProps) {
  const modalityText = [modalities?.join("・"), studyDescription].filter(Boolean).join(" ");
  const nameBlock = (
    <div className="nm min-w-0">
      {/* 氏名は切らない（取り違えを防ぐ）。かなは 1 行で切り、title に全文 */}
      <p className="n text-base leading-5 font-bold break-words text-value" data-testid={nameTestId}>
        {name}
      </p>
      <p className="k overflow-hidden text-xs leading-4 text-ellipsis whitespace-nowrap text-label" title={kana || undefined} data-testid="banner-kana">
        {kana || NONE}
      </p>
    </div>
  );
  const pid = <Field label="患者ID" value={patientId} mono testId="banner-patient-id" />;
  const birth = <Field label="生年月日・性別" value={birthSex} testId="banner-birth" />;
  const acc = <Field label="受付番号" value={accessionNumber} mono testId="detail-accession" />;
  const dt = <Field label="検査日時" value={studyDateTime} testId="banner-datetime" />;
  const md = (
    <Field
      label="モダリティ・検査名"
      cut
      title={modalityText}
      testId="banner-modality"
      value={
        modalityText ? (
          <>
            {modalities?.map((m) => <ModalityMark key={m} modality={m} className="mr-1 align-middle" />)}
            {studyDescription && <span className="font-normal">{studyDescription}</span>}
          </>
        ) : undefined
      }
    />
  );
  const badge = end ? <div className="end flex items-center gap-2">{end}</div> : null;

  return (
    <section
      aria-label="患者"
      data-slot="patient-banner"
      data-layout={layout}
      className={cn("fb rounded-md border border-border bg-surface px-3", layout, className)}
      {...props}
    >
      {layout === "r2" ? (
        <>
          {/* 1 行目：氏名（かな）・患者ID・生年月日と性別 */}
          <div className="grid min-h-10 grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-x-4 py-1">
            {nameBlock}
            {pid}
            {birth}
          </div>
          {/* 2 行目：札・受付番号・検査日時・モダリティと検査名 */}
          <div
            className={cn(
              "grid min-h-10 items-center gap-x-4 border-t border-border py-1",
              badge
                ? "grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)]"
                : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)]",
            )}
          >
            {badge}
            {acc}
            {dt}
            {md}
          </div>
        </>
      ) : (
        <div className="flex min-h-10 items-center gap-x-6 py-1">
          {nameBlock}
          {pid}
          {birth}
          {acc}
          {dt}
          <div className="min-w-0 flex-1">{md}</div>
          {badge && <div className="ml-auto shrink-0">{badge}</div>}
        </div>
      )}
    </section>
  );
}
