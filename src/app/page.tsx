import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { audit, getSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { BackendError, type StudyCount, type StudySummary } from "@/lib/backend/types";
import { searchAuditFields } from "@/lib/search-audit";

// 段 1a の1頁：BFF を通した検査の件数と、検査の一覧（素の表）。
// 一覧の作り込み（絞り込み・氏名の整形・和暦・詳細のパネル）は段 2。

function formatDate(yyyymmdd: string): string {
  return /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}` : yyyymmdd;
}

function formatTime(hhmmss: string): string {
  return /^\d{4}/.test(hhmmss) ? `${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}` : hhmmss;
}

export default async function HomePage() {
  const session = await getSession();
  const backend = getBackend();

  let count: StudyCount;
  let studies: StudySummary[];
  try {
    [count, studies] = await Promise.all([backend.countStudies(), backend.searchStudies()]);
  } catch (error) {
    const message = error instanceof BackendError ? error.message : "検査を読めなかった";
    if (!(error instanceof BackendError)) console.error(error);
    return (
      <p role="alert" className="text-label">
        {message}
      </p>
    );
  }
  await audit(session, searchAuditFields("page", studies));

  return (
    <section className="space-y-3">
      <h1 className="flex items-baseline gap-3">
        <span className="text-label">検査</span>
        <span className="text-lg font-bold text-value" data-testid="study-count">
          {count.count}
          {count.exact ? "" : " 以上"}
        </span>
        <span className="text-label">件</span>
        {backend.mock && <span className="text-xs text-label">（モックのバックエンド）</span>}
      </h1>

      <Table data-testid="study-table">
        <TableCaption>新しい検査から {studies.length} 件</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>検査日</TableHead>
            <TableHead>患者 ID</TableHead>
            <TableHead>氏名</TableHead>
            <TableHead>生年月日</TableHead>
            <TableHead>性別</TableHead>
            <TableHead>モダリティ</TableHead>
            <TableHead>検査の記述</TableHead>
            <TableHead>受付番号</TableHead>
            <TableHead className="text-right">シリーズ</TableHead>
            <TableHead className="text-right">画像</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {studies.map((s) => (
            <TableRow key={s.studyInstanceUid} data-study-uid={s.studyInstanceUid}>
              <TableCell className="whitespace-nowrap">
                {formatDate(s.studyDate)} {formatTime(s.studyTime)}
              </TableCell>
              <TableCell className="font-mono">{s.patientId}</TableCell>
              <TableCell className="font-bold text-value">{s.patientName}</TableCell>
              <TableCell>{formatDate(s.patientBirthDate)}</TableCell>
              <TableCell>{s.patientSex}</TableCell>
              <TableCell>{s.modalities.join("・")}</TableCell>
              <TableCell>{s.studyDescription}</TableCell>
              <TableCell className="font-mono">{s.accessionNumber}</TableCell>
              <TableCell className="text-right">{s.seriesCount ?? ""}</TableCell>
              <TableCell className="text-right">{s.instanceCount ?? ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
